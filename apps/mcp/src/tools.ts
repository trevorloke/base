/**
 * The MCP tools: Meridian's front door for agents.
 * Agents can see the radar, the feed, the queue, the ledger and the red lines, and propose posts.
 * They cannot approve, publish, change policy or connect accounts: humans do that in the app.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActionClass, ActivityKind, LedgerEventType, Network, PostStatus, Timestamp, TrendStage, type Disclosure } from "@meridian/schema";
import { MeridianApiError, type MeridianClient } from "./client.ts";
import * as fmt from "./format.ts";
import type { CreatePostBody } from "./types.ts";

export const TOOL_NAMES = [
  "get_brand_context",
  "get_radar",
  "get_topic",
  "search_feed",
  "get_queue",
  "get_post",
  "list_posts",
  "get_metrics_summary",
  "get_lift_by_stage",
  "check_policy",
  "create_post",
  "schedule_post",
  "cancel_post",
  "get_latest_brief",
  "list_alerts",
  "get_policy",
  "get_ledger",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Recorded on every post this server creates. Humans review in the app; `humanReviewed` flips there. */
export const MCP_MODEL_LABEL = "mcp-client";

export interface ToolContext {
  client: MeridianClient;
  now: () => Date;
}

// ---- input schemas (zod v4 raw shapes; the SDK turns them into JSON Schema) --------------------

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const variantForCheck = z.object({
  network: Network.describe("Network the text is meant for"),
  text: z.string().min(1).describe("Full text including any thread segments joined by newlines"),
});

export const inputs = {
  get_topic: {
    topicId: z.string().min(1).describe("Topic id, as listed by get_radar or get_brand_context"),
  },
  search_feed: {
    q: z.string().min(1).optional().describe("Free-text search over the activity text"),
    networks: z.array(Network).optional().describe("Only these networks"),
    kinds: z.array(ActivityKind).optional().describe("Only these activity kinds (mention, reply, comment, dm, repost, quote, own_post, like, follow)"),
    streamId: z.string().min(1).optional().describe("Only activity matching this saved stream (see the app)"),
    sinceHours: z.number().positive().max(24 * 90).optional().describe("Only activity from the last N hours"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max items (default 50)"),
  },
  get_post: {
    postId: z.string().min(1).describe("Post id, e.g. from get_queue or create_post"),
  },
  list_posts: {
    status: z.array(PostStatus).optional().describe("Only these statuses; default all"),
    limit: z.number().int().min(1).max(200).default(20).describe("Max posts (default 20)"),
  },
  get_metrics_summary: {
    days: z.number().int().min(1).max(365).default(7).describe("Window ending now, in days (default 7)"),
  },
  get_lift_by_stage: {
    days: z.number().int().min(1).max(365).default(30).describe("Window ending now, in days (default 30)"),
  },
  check_policy: {
    variants: z.array(variantForCheck).min(1).describe("One entry per network you intend to post to"),
    scheduledAt: Timestamp.optional().describe("ISO-8601 publish time, so quiet-hours and per-day limits are checked for that moment"),
    actionClass: ActionClass.optional().describe("What kind of action this is (default new_post); decides which autonomy level applies"),
    aiAssisted: z.boolean().default(true).describe("Whether the text is machine-drafted (default true). The same disclosure create_post will record, so disclosure red lines are checked the same way."),
  },
  create_post: {
    title: z.string().max(200).optional().describe("Short internal label shown in the approval queue"),
    body: z.string().min(1).describe("The idea in canonical form; variants adapt it per network"),
    variants: z
      .array(
        z.object({
          socialAccountId: z.string().min(1).describe("Connected account id from get_brand_context"),
          text: z.string().min(1).describe("Text for this account's network, within its character limit"),
          thread: z.array(z.string().min(1)).optional().describe("Additional thread/carousel segments after the first"),
        }),
      )
      .min(1)
      .describe("One variant per connected account to post to"),
    scheduledAt: Timestamp.optional().describe("ISO-8601 publish time. Omit to leave it unscheduled for a human to schedule."),
    actionClass: ActionClass.optional().describe("new_post (default), reply, dm, repost or campaign; each has its own autonomy level"),
    trendTopicId: z.string().min(1).optional().describe("Radar topic this post acts on (from get_radar)"),
    trendStageAtCreation: TrendStage.optional().describe("The topic's stage right now (from get_radar), recorded for the outcome ledger"),
    trendForecastId: z.string().min(1).optional().describe("The forecast id you acted on (from get_radar JSON)"),
    evidence: z
      .array(z.object({ kind: z.string().min(1), ref: z.string().min(1), note: z.string().optional() }))
      .optional()
      .describe("Why this post: links to feed items, radar topics, briefs, e.g. { kind: 'activity', ref: '<id>', note: '...' }"),
    aiAssisted: z.boolean().default(true).describe("Whether the text is machine-drafted (default true); recorded in the disclosure"),
  },
  schedule_post: {
    postId: z.string().min(1).describe("Post id"),
    at: Timestamp.describe("ISO-8601 publish time"),
  },
  cancel_post: {
    postId: z.string().min(1).describe("Post id"),
  },
  list_alerts: {
    unacknowledgedOnly: z.boolean().default(true).describe("Only alerts nobody has acknowledged yet (default true)"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max alerts (default 50)"),
  },
  get_ledger: {
    types: z.array(LedgerEventType).optional().describe("Only these event types, e.g. post.created, policy.blocked, post.approval_decided"),
    subjectType: z.string().min(1).optional().describe("e.g. post, account, policy, trend_topic"),
    subjectId: z.string().min(1).optional().describe("Id of the subject, e.g. a post id"),
    limit: z.number().int().min(1).max(500).default(50).describe("Max events (default 50)"),
  },
};

type Args<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

// ---- result helpers --------------------------------------------------------------------------

/** Readable summary first, raw JSON second. */
export function ok(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data ?? null, null, 2) },
    ],
  };
}

/** Never throw raw: every failure becomes an `isError` result the agent can read. */
export function toolError(err: unknown): CallToolResult {
  const text = err instanceof MeridianApiError ? err.toText() : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text }] };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err);
  }
}

function disclosureFor(aiAssisted: boolean): Disclosure {
  return { aiAssisted, aiContributions: aiAssisted ? ["text_drafted"] : [], humanReviewed: false, model: MCP_MODEL_LABEL };
}

// ---- handlers (exported so they can be tested without MCP plumbing) ----------------------------

export const handlers = {
  get_brand_context: (ctx: ToolContext) =>
    run(async () => {
      const c = await ctx.client.getContext();
      return ok(fmt.formatContext(c), c);
    }),

  get_radar: (ctx: ToolContext) =>
    run(async () => {
      const r = await ctx.client.getRadar();
      return ok(fmt.formatRadar(r), r);
    }),

  get_topic: (ctx: ToolContext, args: Args<typeof inputs.get_topic>) =>
    run(async () => {
      const t = await ctx.client.getTopic(args.topicId);
      return ok(fmt.formatTopic(t), t);
    }),

  search_feed: (ctx: ToolContext, args: Args<typeof inputs.search_feed>) =>
    run(async () => {
      const since = args.sinceHours !== undefined ? new Date(ctx.now().getTime() - args.sinceHours * HOUR_MS).toISOString() : undefined;
      const items = await ctx.client.searchFeed({ q: args.q, networks: args.networks, kinds: args.kinds, stream: args.streamId, since, limit: args.limit });
      return ok(fmt.formatFeed(items), items);
    }),

  get_queue: (ctx: ToolContext) =>
    run(async () => {
      const q = await ctx.client.getQueue();
      return ok(fmt.formatQueue(q), q);
    }),

  get_post: (ctx: ToolContext, args: Args<typeof inputs.get_post>) =>
    run(async () => {
      const d = await ctx.client.getPost(args.postId);
      return ok(fmt.formatPostDetail(d, { history: d.history ?? [] }), d);
    }),

  list_posts: (ctx: ToolContext, args: Args<typeof inputs.list_posts>) =>
    run(async () => {
      const items = await ctx.client.listPosts({ status: args.status, limit: args.limit });
      return ok(fmt.formatPostList(items), items);
    }),

  get_metrics_summary: (ctx: ToolContext, args: Args<typeof inputs.get_metrics_summary>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const s = await ctx.client.getMetricsSummary({ from, to });
      return ok(fmt.formatSummary(s, { from, to, days: args.days }), s);
    }),

  get_lift_by_stage: (ctx: ToolContext, args: Args<typeof inputs.get_lift_by_stage>) =>
    run(async () => {
      const to = ctx.now();
      const from = new Date(to.getTime() - args.days * DAY_MS);
      const rows = await ctx.client.getLiftByStage({ from, to });
      return ok(fmt.formatLift(rows, args.days), rows);
    }),

  check_policy: (ctx: ToolContext, args: Args<typeof inputs.check_policy>) =>
    run(async () => {
      const decision = await ctx.client.checkPolicy({
        variants: args.variants,
        scheduledAt: args.scheduledAt,
        actionClass: args.actionClass,
        disclosure: disclosureFor(args.aiAssisted),
      });
      return ok(fmt.formatPolicyDecision(decision), decision);
    }),

  create_post: (ctx: ToolContext, args: Args<typeof inputs.create_post>) =>
    run(async () => {
      const body: CreatePostBody = {
        title: args.title,
        body: args.body,
        variants: args.variants.map((v) => ({ socialAccountId: v.socialAccountId, text: v.text, thread: v.thread ?? [] })),
        scheduledAt: args.scheduledAt,
        actionClass: args.actionClass ?? "new_post",
        trendTopicId: args.trendTopicId,
        trendStageAtCreation: args.trendStageAtCreation,
        trendForecastId: args.trendForecastId,
        evidence: args.evidence ?? [],
        disclosure: disclosureFor(args.aiAssisted),
      };
      const d = await ctx.client.createPost(body);
      return ok(fmt.formatPostDetail(d, { lead: "Created." }), d);
    }),

  schedule_post: (ctx: ToolContext, args: Args<typeof inputs.schedule_post>) =>
    run(async () => {
      const d = await ctx.client.schedulePost(args.postId, args.at);
      return ok(fmt.formatPostDetail(d, { lead: "Schedule requested." }), d);
    }),

  cancel_post: (ctx: ToolContext, args: Args<typeof inputs.cancel_post>) =>
    run(async () => {
      const d = await ctx.client.cancelPost(args.postId);
      return ok(fmt.formatPostDetail(d, { lead: "Cancelled." }), d);
    }),

  get_latest_brief: (ctx: ToolContext) =>
    run(async () => {
      const b = await ctx.client.getLatestBrief();
      return ok(fmt.formatBrief(b), b);
    }),

  list_alerts: (ctx: ToolContext, args: Args<typeof inputs.list_alerts>) =>
    run(async () => {
      const alerts = await ctx.client.listAlerts({ unacknowledgedOnly: args.unacknowledgedOnly, limit: args.limit });
      return ok(fmt.formatAlerts(alerts, args.unacknowledgedOnly), alerts);
    }),

  get_policy: (ctx: ToolContext) =>
    run(async () => {
      const p = await ctx.client.getPolicy();
      return ok(fmt.formatPolicy(p), p);
    }),

  get_ledger: (ctx: ToolContext, args: Args<typeof inputs.get_ledger>) =>
    run(async () => {
      const events = await ctx.client.getLedger({ types: args.types, subjectType: args.subjectType, subjectId: args.subjectId, limit: args.limit });
      return ok(fmt.formatLedger(events), events);
    }),
} satisfies Record<ToolName, (ctx: ToolContext, ...args: never[]) => Promise<CallToolResult>>;

// ---- registration ----------------------------------------------------------------------------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerTools(server: McpServer, client: MeridianClient, opts: { now?: () => Date } = {}): void {
  const ctx: ToolContext = { client, now: opts.now ?? (() => new Date()) };

  server.registerTool(
    "get_brand_context",
    {
      title: "Brand context",
      description:
        "Call this FIRST, before drafting or proposing anything. Returns the brand profile (description, audience, topics, voice do/don't), " +
        "your autonomy per action class and the red lines you must not cross (in plain language), the connected social accounts " +
        "(you need their ids for create_post), voice examples (before → after edits humans made to earlier drafts; write like the 'after'), " +
        "recent top posts, and the active trend topics.",
      annotations: READ_ONLY,
    },
    () => handlers.get_brand_context(ctx),
  );

  server.registerTool(
    "get_radar",
    {
      title: "Trend radar",
      description:
        "The trend radar: the topics this brand tracks with their forecast stage (dormant, rising, peaking, plateau, fading), confidence, " +
        "estimated hours to peak, the suggested acting window, and how often the brand already acted on each. Sorted by score. " +
        "Use get_topic for detail and pass trendTopicId/trendStageAtCreation/trendForecastId to create_post when you act on one.",
      annotations: READ_ONLY,
    },
    () => handlers.get_radar(ctx),
  );

  server.registerTool(
    "get_topic",
    {
      title: "Topic detail",
      description: "Detail for one radar topic: the forecast with its confidence band, the per-source time series, and the brand's past posts on it with 24h outcomes.",
      inputSchema: inputs.get_topic,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_topic(ctx, args),
  );

  server.registerTool(
    "search_feed",
    {
      title: "Search the live feed",
      description:
        "Search inbound activity across the brand's connected networks (mentions, replies, comments, DMs, reposts, quotes, own posts). " +
        "Filter by free text, networks, kinds, a saved stream and a window in hours. Newest first. Use it to find what to respond to and as evidence for create_post.",
      inputSchema: inputs.search_feed,
      annotations: READ_ONLY,
    },
    (args) => handlers.search_feed(ctx, args),
  );

  server.registerTool(
    "get_queue",
    {
      title: "Approval queue",
      description: "Posts waiting on a human in the approval queue, oldest first. Read-only: approving and rejecting happen in the Meridian app, never through this server.",
      annotations: READ_ONLY,
    },
    () => handlers.get_queue(ctx),
  );

  server.registerTool(
    "get_post",
    {
      title: "Post detail",
      description: "One post with its variants, approvals, policy decision and full ledger history (creation, red-line decisions, approvals and edits, scheduling, publishing).",
      inputSchema: inputs.get_post,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_post(ctx, args),
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description: "Posts newest first, optionally filtered by status (draft, pending_approval, approved, scheduled, publishing, published, partially_published, failed, cancelled, blocked).",
      inputSchema: inputs.list_posts,
      annotations: READ_ONLY,
    },
    (args) => handlers.list_posts(ctx, args),
  );

  server.registerTool(
    "get_metrics_summary",
    {
      title: "Outcome summary",
      description:
        "Outcomes for the last N days (default 7): impressions and engagements, what was published per network, engagement by network / trend stage / hour / author / experiment arm, and the top posts with lift versus the 24h baseline.",
      inputSchema: inputs.get_metrics_summary,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_metrics_summary(ctx, args),
  );

  server.registerTool(
    "get_lift_by_stage",
    {
      title: "Lift by trend stage",
      description:
        "Average engagements and lift versus baseline for posts grouped by the trend stage they were created in (last N days, default 30). This is the evidence for whether acting early on rising topics pays for this brand.",
      inputSchema: inputs.get_lift_by_stage,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_lift_by_stage(ctx, args),
  );

  server.registerTool(
    "check_policy",
    {
      title: "Check red lines (dry run)",
      description:
        "Dry-run the brand's red lines and autonomy against draft text per network. Nothing is created or stored. Use it before create_post: " +
        "fix every 'block' violation (it would be blocked for real), and expect a human review on 'require_approval'. " +
        "The same AI-assisted disclosure create_post records is included, so disclosure red lines are evaluated the same way.",
      inputSchema: inputs.check_policy,
      annotations: READ_ONLY,
    },
    (args) => handlers.check_policy(ctx, args),
  );

  server.registerTool(
    "create_post",
    {
      title: "Propose a post",
      description:
        "Propose a post: one idea with one text variant per connected account. The server runs the red lines and the autonomy dial and decides where it lands: " +
        "usually the approval queue (pending_approval), otherwise draft or scheduled, or blocked when a red line is crossed (the block is recorded in the ledger). " +
        "You cannot approve or publish; humans do that in the Meridian app. Get account ids and voice from get_brand_context and dry-run with check_policy first. " +
        "The post is recorded as AI-assisted and not yet human-reviewed. The result states plainly where the post landed.",
      inputSchema: inputs.create_post,
      annotations: { ...WRITES, idempotentHint: false },
    },
    (args) => handlers.create_post(ctx, args),
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule a post",
      description: "Ask to schedule an existing post (draft or approved) at an ISO-8601 time. Autonomy decides whether it is scheduled directly or waits for a human.",
      inputSchema: inputs.schedule_post,
      annotations: { ...WRITES, idempotentHint: true },
    },
    (args) => handlers.schedule_post(ctx, args),
  );

  server.registerTool(
    "cancel_post",
    {
      title: "Cancel a post",
      description: "Cancel a post that has not published yet; it leaves the queue or schedule. Cannot be undone (create a new post instead).",
      inputSchema: inputs.cancel_post,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => handlers.cancel_post(ctx, args),
  );

  server.registerTool(
    "get_latest_brief",
    {
      title: "Latest brief",
      description: "The most recent operator brief: a Markdown digest of what happened on the brand's surfaces, what moved and what is coming, with evidence.",
      annotations: READ_ONLY,
    },
    () => handlers.get_latest_brief(ctx),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "Alerts",
      description: "Operator alerts (urgent, attention, info): mention spikes, trend windows opening, accounts needing re-auth. Unacknowledged only by default; acknowledging happens in the app.",
      inputSchema: inputs.list_alerts,
      annotations: READ_ONLY,
    },
    (args) => handlers.list_alerts(ctx, args),
  );

  server.registerTool(
    "get_policy",
    {
      title: "Policy document",
      description: "The full active policy: autonomy per action class, every red line with its parameters (phrases, keywords, patterns, quiet hours...), spend caps, disclosure settings and timezone. Read-only: policy changes are made by owners in the app.",
      annotations: READ_ONLY,
    },
    () => handlers.get_policy(ctx),
  );

  server.registerTool(
    "get_ledger",
    {
      title: "Ledger",
      description: "Query the append-only ledger: every fact Meridian asserts (post.created, policy.blocked, post.approval_decided, post.published, outcome.captured, operator.alert...). Filter by event types and subject. Newest first.",
      inputSchema: inputs.get_ledger,
      annotations: READ_ONLY,
    },
    (args) => handlers.get_ledger(ctx, args),
  );
}
