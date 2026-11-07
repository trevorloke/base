/**
 * Seed a demo workspace with a week of history so every panel has something to show:
 * accounts, red lines, streams, topics with multi-source trend points and forecasts, posts that
 * went out (with captured outcomes), a queue of proposals waiting on a human, feed items, alerts, a brief.
 * Deterministic. Safe to re-run: it mints a fresh API key and a fresh sign-in password each time and skips the rest if the workspace exists.
 */
import { randomBytes } from "node:crypto";
import { createDb, migrate } from "@base-air/db";
import { ConnectorRegistry, MockConnector } from "@base-air/connectors";
import { InMemoryScheduler, BaseAir, SecretBox, type Principal } from "@base-air/core";
import { networkLabel, type TrendStage } from "@base-air/schema";

const SLUG = process.env.SEED_SLUG ?? "acme";
const realNow = Date.now();
let clock = realNow - 8 * 86_400_000;
const now = () => new Date(clock);
const H = 3_600_000;
let seedState = 7;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Push the fake clock forward until it is between 09:00 and 19:00 Vancouver time (the quiet-hours red line is real). */
function toDaytime(): void {
  for (let i = 0; i < 24; i++) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", hour: "numeric", hour12: false }).formatToParts(now()).find((p) => p.type === "hour")?.value ?? 0) % 24;
    if (hour >= 9 && hour < 19) return;
    clock += H;
  }
}

const handle = await createDb({ url: process.env.DATABASE_URL, pglitePath: process.env.DATABASE_URL ? undefined : process.env.PGLITE_PATH ?? ".pglite" });
await migrate(handle);
const mock = new MockConnector();
mock.now = now;
const m = new BaseAir({ handle, connectors: new ConnectorRegistry().register(mock), scheduler: new InMemoryScheduler(), secrets: SecretBox.fromEnv(), now });

/** The demo's sign-in person: an owner of the seeded workspace with a fresh random password (printed, never stored in clear). */
const SIGN_IN_EMAIL = process.env.SEED_EMAIL ?? `owner@${SLUG}.test`;
async function signInOwner(workspaceId: string): Promise<{ email: string; password: string }> {
  const password = randomBytes(12).toString("base64url"); // 16 characters
  const user = await m.workspaces.ensureUser(SIGN_IN_EMAIL, "Demo Owner");
  await m.auth.setPassword(user.id, password);
  if ((await m.workspaces.memberRole(workspaceId, user.id)) !== "owner") await m.workspaces.addMember(workspaceId, user.id, "owner");
  return { email: SIGN_IN_EMAIL, password };
}

const existing = await m.workspaces.bySlug(SLUG);
if (existing) {
  const { secret } = await m.workspaces.createApiKey({ workspaceId: existing.id, name: `seed key ${new Date().toISOString()}`, actorType: "human", actorId: "u_trevor", role: "owner" });
  const login = await signInOwner(existing.id);
  console.log(`workspace "${SLUG}" already seeded.\n  Sign in:            ${login.email} / ${login.password}  (new password)\n  New owner API key:  ${secret}`);
  await handle.close();
  process.exit(0);
}

const founder = { type: "human" as const, id: "u_trevor" };
const ws = await m.workspaces.create(
  {
    slug: SLUG,
    name: "Acme Outdoor Co.",
    timezone: "America/Vancouver",
    profile: {
      description: "Direct-to-consumer outdoor gear brand based in Vancouver. Practical, warm, a little dry. We talk like a guide, not a billboard.",
      audience: "Weekend hikers and new backpackers in the Pacific Northwest, 25-45.",
      topics: ["trail conditions", "gear care", "beginner backpacking", "Leave No Trace", "local trails"],
      voice: {
        do: ["lead with something useful", "short sentences", "name the trail or the gear specifically", "admit tradeoffs"],
        dont: ["hype", "exclamation marks", "superlatives", "FOMO countdowns"],
        examples: ["The Howe Sound trail is a mud bath this week. Gaiters, not new boots.", "Our rain shell is not the lightest. It is the one you will still own in ten years."],
      },
      competitors: ["MEC", "Arc'teryx", "REI"],
    },
  },
  founder,
);
const owner: Principal = { workspaceId: ws.id, actor: founder, role: "owner" };
const editor: Principal = { workspaceId: ws.id, actor: { type: "human", id: "u_sam" }, role: "editor" };
const studio: Principal = { workspaceId: ws.id, actor: { type: "operator", id: "studio" } };
const u = await m.workspaces.ensureUser("trevor@example.com", "Trevor");
await m.workspaces.addMember(ws.id, u.id, "owner");

const acct: Record<string, string> = {};
for (const [network, handleName] of [["x", "acmeoutdoor"], ["bluesky", "acmeoutdoor.bsky.social"], ["instagram", "acmeoutdoor"], ["linkedin", "acme-outdoor-co"]] as const) {
  acct[network] = (await m.accounts.connect(owner, { network, externalId: `${network}-1001`, handle: handleName, displayName: "Acme Outdoor", connector: "mock", auth: { token: `demo-${network}` } })).id;
}

await m.policy.update(owner, {
  autonomy: { new_post: "schedule_with_approval", reply: "draft", dm: "suggest", repost: "draft", campaign: "suggest" },
  requireApprovalForEditors: true,
  redLines: [
    { id: "no-guarantees", kind: "forbidden_phrase", description: "Never promise outcomes", severity: "block", phrases: ["guaranteed", "risk-free", "never fails"] },
    { id: "no-politics", kind: "forbidden_topic", description: "We don't comment on elections or parties", severity: "block", keywords: ["election", "ballot", "candidate", "party leader"], semantic: true },
    { id: "no-safety-claims", kind: "forbidden_claim", description: "No safety or medical claims", severity: "block", patterns: ["(prevents?|cures?|protects? (you )?from) (hypothermia|injury|frostbite)"] },
    { id: "competitors", kind: "no_competitor_mention", description: "Naming a competitor needs a human", severity: "require_approval", competitors: ["MEC", "Arc'teryx", "REI"] },
    { id: "quiet", kind: "quiet_hours", description: "Nothing goes out overnight", severity: "require_approval", timezone: "America/Vancouver", startHour: 22, endHour: 6, days: [] },
    { id: "ai-disclosure", kind: "required_disclosure", description: "AI-assisted posts carry the record (visible tag optional)", severity: "warn", requiredText: "#AIassisted", when: "ai_assisted" },
    { id: "x-cadence", kind: "max_posts_per_day", description: "At most 4 posts a day on X", severity: "warn", limit: 4, networks: ["x"] },
  ],
  competitors: ["MEC", "Arc'teryx", "REI"],
  spendCaps: { xReadsUsdMonthly: 50, modelUsdMonthly: 100 },
  timezone: "America/Vancouver",
});

const streams = {
  competitors: (await m.listening.createStream(owner, { name: "Competitors", query: { keywords: ["MEC", "Arc'teryx", "REI"] } })).id,
  support: (await m.listening.createStream(owner, { name: "Support", query: { keywords: ["zipper", "warranty", "return", "refund", "broke"] } })).id,
  trails: (await m.listening.createStream(owner, { name: "Trail talk", query: { keywords: ["trail", "hike", "summit", "mud"] } })).id,
};

// ---------------------------------------------------------------- topics with multi-source points
type Shape = (hoursAgo: number) => number; // value at (now - hoursAgo)
// Shapes are functions of "hours ago". `center` is how many hours ago the midpoint (logistic) or peak (gaussian) sits:
// positive = already happened, negative = still ahead.
const logistic = (center: number, scale: number, amp: number, base = 10): Shape => (ago) => base + amp / (1 + Math.exp(-(center - ago) / scale));
const gaussian = (center: number, width: number, amp: number, base = 10): Shape => (ago) => base + amp * Math.exp(-((ago - center) ** 2) / (2 * width ** 2));
const flat = (level: number): Shape => () => level;
const topicsSpec: { name: string; keywords: string[]; relevance: number; shape: Shape; sources: string[]; hours: number }[] = [
  // midpoint 14h ago: well past the inflection, decelerating -> rising with a visible time-to-peak
  { name: "First snow on the North Shore", keywords: ["north shore snow", "first snow", "grouse grind snow"], relevance: 0.95, shape: logistic(14, 8, 180), sources: ["google_trends", "bluesky_firehose", "wikipedia_pageviews"], hours: 7 * 24 },
  // midpoint 20h ahead: still accelerating
  { name: "Microspikes vs. crampons", keywords: ["microspikes", "crampons", "winter traction"], relevance: 0.9, shape: logistic(-20, 8, 140), sources: ["google_trends", "youtube_trending"], hours: 7 * 24 },
  // rose 60h ago and stayed up: plateau
  { name: "Leave No Trace week", keywords: ["leave no trace", "LNT"], relevance: 0.8, shape: logistic(60, 8, 90), sources: ["google_trends", "wikipedia_pageviews"], hours: 7 * 24 },
  // peaked 30h ago: fading
  { name: "Viral 'ultralight' thread", keywords: ["ultralight", "base weight"], relevance: 0.6, shape: gaussian(30, 14, 220), sources: ["x", "bluesky_firehose"], hours: 7 * 24 },
  { name: "Down jacket recall rumor", keywords: ["down jacket recall", "jacket recall"], relevance: 0.5, shape: flat(12), sources: ["google_trends"], hours: 7 * 24 },
  // sharp rise, midpoint 2h ago, one source, 9 hours of data: rising but thin
  { name: "Atmospheric river warning", keywords: ["atmospheric river", "rain warning vancouver"], relevance: 0.85, shape: logistic(2, 3, 160), sources: ["google_trends"], hours: 9 },
];
const topics: Record<string, { id: string; stage: TrendStage | null; forecastId: string | null }> = {};
clock = realNow;
for (const spec of topicsSpec) {
  const t = await m.trends.createTopic({ workspaceId: ws.id, name: spec.name, keywords: spec.keywords, relevance: spec.relevance });
  const pts: unknown[] = [];
  spec.sources.forEach((source, si) => {
    const scale = source === "wikipedia_pageviews" ? 40 : source === "bluesky_firehose" ? 0.3 : source === "youtube_trending" ? 5 : 1;
    for (let ago = spec.hours; ago >= 1; ago--) {
      const v = Math.max(0, spec.shape(ago) * scale * (1 + (rnd() - 0.5) * 0.12) + si);
      pts.push({ topicId: t.id, source, value: v, observedAt: new Date(realNow - ago * H).toISOString() });
    }
  });
  await m.trends.recordPoints(pts, owner);
  topics[spec.name] = { id: t.id, stage: null, forecastId: null };
}
// Forecasts at "now" (the radar needs them); we remember stage per topic for the post history below.
for (const spec of topicsSpec) {
  const f = await m.trends.computeForecast(topics[spec.name]!.id);
  topics[spec.name]!.stage = f.stage;
  topics[spec.name]!.forecastId = f.id;
}

// ---------------------------------------------------------------- a week of posts with outcomes
clock = realNow - 7 * 86_400_000;
toDaytime();
const history: { body: string; networks: string[]; topic?: string; stage?: TrendStage; by?: Principal }[] = [
  { body: "Trail report: Lynn Loop is clear, Norvan Falls has ice above the second bridge. Spikes, not boots with 'good grip'.", networks: ["x", "bluesky", "instagram"], topic: "Microspikes vs. crampons", stage: "rising" },
  { body: "Gear care, part one: wash your rain shell. The DWR is not dead, it is dirty.", networks: ["x", "instagram"] },
  { body: "Microspikes are for packed snow and ice on trails. Crampons are for mountaineering. Buying crampons for the Grind is like buying a truck to carry groceries.", networks: ["x", "bluesky", "linkedin"], topic: "Microspikes vs. crampons", stage: "rising" },
  { body: "We read the ultralight thread too. Base weight matters less than whether you will actually carry the thing. Carry the thing.", networks: ["x", "bluesky"], topic: "Viral 'ultralight' thread", stage: "peaking" },
  { body: "Leave No Trace week: pack out the orange peel. It takes two years to break down up there.", networks: ["instagram", "x"], topic: "Leave No Trace week", stage: "plateau" },
  { body: "Our rain shell is not the lightest. It is the one you will still own in ten years.", networks: ["x", "linkedin"] },
  { body: "Still seeing ultralight takes. The thread has peaked; the trails have not changed.", networks: ["x"], topic: "Viral 'ultralight' thread", stage: "fading" },
  { body: "Three questions before you buy winter boots: how cold, how wet, how far. Answer those and the aisle gets short.", networks: ["x", "bluesky", "instagram"] },
  { body: "Early flakes on Seymour this morning. Not enough to matter yet. We will say when it does.", networks: ["x", "bluesky"], topic: "First snow on the North Shore", stage: "rising" },
  { body: "Staff pick: the cheap foam sit pad. Fourteen dollars, lives in every one of our packs.", networks: ["instagram", "x"] },
];
const publishedPosts: string[] = [];
for (let i = 0; i < history.length; i++) {
  const h = history[i]!;
  const t = h.topic ? topics[h.topic] : undefined;
  // Posts riding rising topics get a longer body so the mock connector's text-length-driven metrics show lift. Demo only.
  const body = h.stage === "rising" ? `${h.body} More on this in the thread: how we test, what we recommend, and what we would skip this season.` : h.body;
  const r = await m.posts.create(owner, {
    body,
    variants: h.networks.map((n) => ({ socialAccountId: acct[n]!, text: n === "x" ? body.slice(0, 280) : body, media: n === "instagram" ? [{ kind: "image", url: "https://example.com/trail.jpg", alt: "trail" }] : [] })),
    scheduledAt: now().toISOString(),
    trendTopicId: t?.id,
    trendStageAtCreation: h.stage,
    trendForecastId: t?.forecastId ?? undefined,
  });
  await m.publishing.publishPost(r.post.id);
  publishedPosts.push(r.post.id);
  clock += (14 + Math.floor(rnd() * 12)) * H; // next post 14-26h later
  toDaytime();
  await m.metrics.captureDueOutcomes();
}
// Walk the clock to real now capturing outcomes along the way.
while (clock < realNow) {
  clock = Math.min(realNow, clock + 6 * H);
  await m.metrics.captureDueOutcomes();
}

// ---------------------------------------------------------------- the queue: proposals waiting on a human
clock = realNow - 2 * H;
const snow = topics["First snow on the North Shore"]!;
await m.posts.create(studio, {
  body: "First real snow on the North Shore overnight. Grouse and Seymour trails are icy above 700m. Spikes on, poles out, turn around when the tracks disappear.",
  variants: [
    { socialAccountId: acct.x!, text: "First real snow on the North Shore overnight. Grouse and Seymour trails are icy above 700m. Spikes on, poles out, turn around when the tracks disappear." },
    { socialAccountId: acct.bluesky!, text: "First real snow on the North Shore overnight. Icy above 700m on Grouse and Seymour. Spikes on, poles out, turn around when the tracks disappear." },
    { socialAccountId: acct.instagram!, text: "First snow on the North Shore. Icy above 700m. Spikes on, poles out, turn around when the tracks disappear.", media: [{ kind: "image", url: "https://example.com/snow.jpg", alt: "fresh snow on a forest trail" }] },
  ],
  scheduledAt: new Date(realNow + 2 * H).toISOString(),
  trendTopicId: snow.id,
  trendStageAtCreation: snow.stage ?? undefined,
  trendForecastId: snow.forecastId ?? undefined,
  disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5", promptVersion: "draftForTrend@1" },
  evidence: [
    { kind: "forecast", ref: snow.forecastId ?? "", note: "rising, 3 sources agree, ~6h to peak" },
    { kind: "ledger", ref: publishedPosts[8] ?? "", note: "last snow post did 2.4x baseline at 24h" },
  ],
});
const river = topics["Atmospheric river warning"]!;
await m.posts.create(studio, {
  body: "Atmospheric river warning for the weekend. Creek crossings on the Howe Sound trail will be impassable Saturday. Go Sunday afternoon or go somewhere flat.",
  variants: [{ socialAccountId: acct.x!, text: "Atmospheric river warning for the weekend. Creek crossings on the Howe Sound trail will be impassable Saturday. Go Sunday afternoon or go somewhere flat." }],
  scheduledAt: new Date(realNow + 5 * H).toISOString(),
  trendTopicId: river.id,
  trendStageAtCreation: river.stage ?? undefined,
  trendForecastId: river.forecastId ?? undefined,
  disclosure: { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false, model: "claude-opus-5-5", promptVersion: "draftForTrend@1" },
  evidence: [{ kind: "forecast", ref: river.forecastId ?? "", note: "rising fast but only one source and 9h of data: thin" }],
});
await m.posts.create(editor, {
  body: "Honest comparison: our shell vs. the MEC one. Theirs is lighter. Ours is warmer and the zipper is better. Pick by your weather.",
  variants: [{ socialAccountId: acct.x!, text: "Honest comparison: our shell vs. the MEC one. Theirs is lighter. Ours is warmer and the zipper is better. Pick by your weather." }],
  scheduledAt: new Date(realNow + 26 * H).toISOString(),
});

// ---------------------------------------------------------------- the feed
const feedItems: unknown[] = [];
const voices = [
  ["x", "mention", "trailrunner_jo", "Jo", "@acmeoutdoor your spikes saved my ankles on Norvan this morning, thank you"],
  ["x", "reply", "pnw_dad", "Mike", "What about kids sizes for the spikes?"],
  ["bluesky", "mention", "hikebc.bsky.social", "Hike BC", "Good trail report from @acmeoutdoor.bsky.social today, mud is real on the Baden Powell"],
  ["instagram", "comment", "sarah.hikes", "Sarah", "Zipper on my shell broke after two seasons, is that covered by warranty?"],
  ["x", "mention", "gearnerd", "Gear Nerd", "Comparing the acmeoutdoor shell to the MEC one this weekend, the hood is the difference"],
  ["linkedin", "comment", "dana-m", "Dana M.", "Love the honest tone of this brand. More companies should admit tradeoffs."],
  ["x", "quote", "summitseeker", "Priya", "This is the right take on crampons vs microspikes"],
  ["bluesky", "reply", "mossy.bsky.social", "Mossy", "the orange peel fact got me, did not know"],
  ["x", "mention", "weekendwarrior", "Tom", "Anyone done the Howe Sound trail in the rain? asking for a friend (me)"],
  ["instagram", "comment", "trailmix", "Trail Mix", "return policy if the boots don't fit?"],
  ["x", "reply", "coldfeet", "Alex", "the foam sit pad is elite, agreed"],
  ["x", "mention", "arcfan", "Arc Fan", "Arc'teryx or acmeoutdoor for a shell under 400? honest answers only"],
] as const;
voices.forEach((v, i) => {
  feedItems.push({ network: v[0], kind: v[1], externalId: `seed-${i}`, authorHandle: v[2], authorName: v[3], text: v[4], url: null, parentExternalId: null, occurredAt: new Date(realNow - (i * 3 + 1) * H).toISOString(), raw: { seed: i } });
});
clock = realNow;
// Each item arrives through the account it was said to (so the room offers Reply, Like and Hide on it).
for (const network of new Set(voices.map((v) => v[0]))) {
  await m.listening.ingestItems(ws.id, acct[network] ?? null, feedItems.filter((f) => (f as { network: string }).network === network));
}

// ---------------------------------------------------------------- alerts and a brief
await m.ops.raiseAlert(ws.id, { type: "operator", id: "watch" }, {
  kind: "trend_window",
  severity: "attention",
  title: "First snow is rising; window is about 6 hours",
  body: "Three sources agree. The last snow post did 2.4x baseline at 24h. A draft is waiting in the queue.",
  evidence: [{ kind: "forecast", ref: snow.forecastId ?? "" }],
  topicId: snow.id,
});
await m.ops.raiseAlert(ws.id, { type: "operator", id: "desk" }, {
  kind: "support",
  severity: "urgent",
  title: "Two warranty questions in the feed without a reply",
  body: "Zipper warranty (Instagram) and boot returns (Instagram) have been open for 4+ hours.",
  evidence: [{ kind: "stream", ref: streams.support }],
});
const s = await m.metrics.summary(ws.id, new Date(realNow - 7 * 86_400_000), new Date(realNow), "America/Vancouver");
const lift = await m.metrics.liftByStage(ws.id, new Date(realNow - 30 * 86_400_000), new Date(realNow));
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const brief = `# Week in attention

**${fmt(s.publishedByNetwork.reduce((a, b) => a + b.posts, 0))} posts went out** across ${s.publishedByNetwork.length} networks; ${s.measuredAt24h} have a 24-hour read. They earned **${fmt(s.totals.impressions)} impressions** and **${fmt(s.totals.engagements)} engagements**. Baseline is ${fmt(s.baselineEngagements24h)} engagements per post at 24h.

## What moved
${lift
  .filter((l) => l.stage !== "no_trend")
  .map((l) => `- Posts on **${l.stage}** topics: ${l.posts} post(s), ${fmt(l.avgEngagements)} avg engagements${l.lift ? ` (${l.lift.toFixed(1)}x baseline)` : ""}`)
  .join("\n")}
- Posts with no trend behind them: ${lift.find((l) => l.stage === "no_trend")?.posts ?? 0} post(s), ${fmt(lift.find((l) => l.stage === "no_trend")?.avgEngagements ?? 0)} avg engagements

## By network
${s.byNetwork.map((n) => `- ${networkLabel(n.key)}: ${n.posts} post(s), ${fmt(n.avgEngagements)} avg engagements`).join("\n")}

## Best hours (local)
${s.byHour.slice(0, 3).map((h) => `- ${h.key}:00 — ${fmt(h.avgEngagements)} avg engagements over ${h.posts} post(s)`).join("\n")}

## Confidence
One week of data on one brand. Treat the stage lift as a direction, not a number to quote. The pattern to test next week: post on rising topics within the window, once, with a specific trail or product named.`;
await m.ops.saveBrief(ws.id, { type: "operator", id: "analyst" }, { periodStart: new Date(realNow - 7 * 86_400_000), periodEnd: new Date(realNow), contentMd: brief, evidence: [{ kind: "summary", ref: "metrics.summary" }, { kind: "lift", ref: "metrics.liftByStage" }] });

const ownerKey = await m.workspaces.createApiKey({ workspaceId: ws.id, name: "trevor (owner)", actorType: "human", actorId: "u_trevor", role: "owner" });
const agentKey = await m.workspaces.createApiKey({ workspaceId: ws.id, name: "claude (mcp)", actorType: "mcp", actorId: "claude" });
const login = await signInOwner(ws.id);
console.log(`
Seeded workspace "${ws.slug}" (${ws.name}) with ${history.length} published posts, 3 proposals waiting, ${topicsSpec.length} topics, ${voices.length} feed items.

Sign in (web app):              ${login.email} / ${login.password}
Owner API key (CLI, scripts):   ${ownerKey.secret}
Agent API key (MCP server):     ${agentKey.secret}

Next:
  pnpm dev:api                      # http://localhost:4000  (or set BASE_AIR_DEV_WORKSPACE=${ws.slug} to skip signing in)
  pnpm dev:web                      # sign in with the email and password above
  BASE_AIR_API_KEY=<agent key> pnpm dev:mcp
`);
await handle.close();
