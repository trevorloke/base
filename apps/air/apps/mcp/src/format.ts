/**
 * Readable summaries for tool results. Pure functions: API shape in, text out.
 * Every tool puts one of these first and the raw JSON second.
 */
import type { AutonomyLevel, PolicyDecision, PostStatus, RedLine, RedLineSeverity, Violation } from "@base-air/schema";
import type {
  Activity,
  Alert,
  BrandContext,
  Brief,
  LedgerEvent,
  LiftByStage,
  MetricsGroup,
  MetricsSummary,
  Policy,
  Post,
  PostDetail,
  PostSummary,
  RadarEntry,
  TopicDetail,
} from "./types.ts";

// ---- small helpers ----------------------------------------------------------------------------

/** 0.724 -> "72%" */
export function pct(x: number | null | undefined): string {
  return x === null || x === undefined || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`;
}

/** 5.25 -> "5.3h", 36.7 -> "37h", null -> "—" */
export function hoursLabel(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "—";
  return h < 10 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h)}h`;
}

export function excerpt(text: string | null | undefined, max = 140): string {
  if (!text) return "";
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function when(iso: string | null | undefined): string {
  return iso ? iso.replace(/\.\d{3}Z$/, "Z") : "—";
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function compactJson(x: unknown, max = 160): string {
  const s = JSON.stringify(x);
  return s === undefined ? "" : s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function actorLabel(a: { type: string; id: string } | null | undefined): string {
  return a ? `${a.type}:${a.id}` : "—";
}

function liftLabel(x: number | null | undefined): string {
  return x === null || x === undefined || Number.isNaN(x) ? "—" : `${x.toFixed(2)}x`;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1);
}

function quote(s: string): string {
  return JSON.stringify(s);
}

// ---- plain-language vocab ---------------------------------------------------------------------

export const AUTONOMY_TEXT: Record<AutonomyLevel, string> = {
  suggest: "suggest only: you may surface ideas, nothing can be created",
  draft: "draft: you may create drafts; a human must schedule them",
  schedule_with_approval: "schedule with approval: you may propose and schedule, but nothing publishes until a human approves",
  autopost: "autopost: may publish directly (red lines still apply)",
};

export const SEVERITY_TEXT: Record<RedLineSeverity, string> = {
  block: "hard stop",
  require_approval: "needs a human",
  warn: "warning",
};

export const STATUS_TEXT: Record<PostStatus, string> = {
  draft: "It is saved as a draft. Nothing is scheduled; a human must schedule it in the base air app.",
  pending_approval: "It landed in the approval queue. A human must approve it in the base air app before anything publishes.",
  approved: "It is approved and waiting to be scheduled.",
  scheduled: "It is scheduled and will publish at the scheduled time unless a human cancels it.",
  publishing: "It is publishing right now.",
  published: "It is published.",
  partially_published: "It is partially published: at least one variant failed.",
  failed: "It failed to publish.",
  cancelled: "It is cancelled and will not publish.",
  blocked: "It was BLOCKED by the brand's red lines. The attempt is recorded in the ledger; this post will never publish. Fix the violations and create a new post.",
};

export function describeStatus(post: Post): string {
  const base = STATUS_TEXT[post.status] ?? `Status ${post.status}.`;
  if (post.status === "scheduled" && post.scheduledAt) return `${base} Scheduled for ${when(post.scheduledAt)}.`;
  if (post.status === "pending_approval" && post.scheduledAt) return `${base} If approved it publishes at ${when(post.scheduledAt)}.`;
  return base;
}

/** `Post.policyDecision` is `unknown` on the wire; narrow it. */
export function policyDecisionOf(x: unknown): PolicyDecision | null {
  if (typeof x !== "object" || x === null) return null;
  const d = x as Partial<PolicyDecision>;
  if (typeof d.verdict !== "string" || !Array.isArray(d.violations)) return null;
  return d as PolicyDecision;
}

// ---- policy ----------------------------------------------------------------------------------

export function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "  (none)";
  return violations
    .map((v) => {
      const matches = v.matches && v.matches.length > 0 ? `; matched: ${v.matches.map(quote).join(", ")}` : "";
      return `  - [${SEVERITY_TEXT[v.severity] ?? v.severity}] ${v.message} — red line "${v.redLineId}" (${v.kind})${matches}`;
    })
    .join("\n");
}

export function formatPolicyDecision(d: PolicyDecision): string {
  const lines: string[] = [];
  switch (d.verdict) {
    case "block":
      lines.push("Verdict: block. This text would be BLOCKED by the brand's red lines; create_post would record a blocked post that never publishes. Fix every hard-stop violation below.");
      break;
    case "require_approval":
      lines.push("Verdict: require_approval. Allowed, but a human must approve it before anything publishes (it would land in the approval queue).");
      break;
    case "allow":
      lines.push("Verdict: allow. No red lines crossed.");
      break;
    default:
      lines.push(`Verdict: ${String(d.verdict)}.`);
  }
  if (d.autonomy) {
    lines.push(`Autonomy that applies to you: ${AUTONOMY_TEXT[d.autonomy] ?? d.autonomy}.`);
    if (d.verdict === "allow" && d.autonomy !== "autopost") lines.push("Even when allowed, where the post lands is decided by that autonomy level, so expect a human in the loop.");
  }
  lines.push(`Policy version ${d.policyVersion}.`);
  if (d.violations.length > 0) lines.push(`Violations (${d.violations.length}):`, formatViolations(d.violations));
  return lines.join("\n");
}

function redLineDetail(r: RedLine): string {
  switch (r.kind) {
    case "forbidden_phrase":
      return `phrases: ${r.phrases.map(quote).join(", ")}`;
    case "forbidden_topic":
      return `keywords: ${r.keywords.join(", ")}${r.semantic ? " (semantic classifier on)" : ""}`;
    case "forbidden_claim":
      return `claim patterns: ${r.patterns.map((p) => `/${p}/`).join(" ")}`;
    case "no_competitor_mention":
      return `competitors: ${r.competitors.join(", ")}`;
    case "quiet_hours": {
      const days = r.days && r.days.length > 0 ? ` on days ${r.days.join(",")} (0=Sun)` : " every day";
      return `no publishing ${String(r.startHour).padStart(2, "0")}:00–${String(r.endHour).padStart(2, "0")}:00 ${r.timezone}${days}`;
    }
    case "required_disclosure":
      return `${quote(r.requiredText)} must appear when: ${r.when}`;
    case "max_posts_per_day":
      return `at most ${r.limit}/day${r.networks && r.networks.length > 0 ? ` on ${r.networks.join(", ")}` : ""}`;
    case "network_restriction":
      return `never post to: ${r.networks.join(", ")}`;
    case "custom_regex":
      return `/${r.pattern}/${r.flags}`;
    default:
      return "";
  }
}

export function formatAutonomy(autonomy: Partial<Record<string, AutonomyLevel>>): string {
  const entries = Object.entries(autonomy);
  if (entries.length === 0) return "  (not configured: the default is conservative)";
  return entries.map(([cls, level]) => `  - ${cls}: ${level ? (AUTONOMY_TEXT[level] ?? level) : "—"}`).join("\n");
}

export function formatPolicy(p: Policy): string {
  const lines: string[] = [];
  lines.push(`Policy v${p.version} (timezone ${p.timezone}).`);
  lines.push("Autonomy per action class (what an agent may do without a human):");
  lines.push(formatAutonomy(p.autonomy));
  lines.push(`Editors need an approver: ${p.requireApprovalForEditors ? "yes" : "no"}.`);
  lines.push(`Red lines (${p.redLines.length}), enforced on every post from every actor:`);
  lines.push(
    p.redLines.length === 0
      ? "  (none declared)"
      : p.redLines.map((r) => `  - [${SEVERITY_TEXT[r.severity] ?? r.severity}] ${r.description} — ${r.kind}: ${redLineDetail(r)} (id ${r.id})`).join("\n"),
  );
  if (p.competitors.length > 0) lines.push(`Competitors: ${p.competitors.join(", ")}.`);
  lines.push(`Spend caps: X reads $${p.spendCaps.xReadsUsdMonthly}/month, model $${p.spendCaps.modelUsdMonthly}/month.`);
  lines.push(
    `Disclosure: ${p.disclosure.visibleTextForAi ? `AI-assisted posts carry the visible text ${quote(p.disclosure.visibleTextForAi)}` : "no visible text appended to AI-assisted posts"}; the internal disclosure record is always kept; media signing ${p.disclosure.signMedia ? "on" : "off"}.`,
  );
  return lines.join("\n");
}

// ---- posts -----------------------------------------------------------------------------------

export function formatPostDetail(d: PostDetail, opts: { lead?: string; history?: LedgerEvent[] } = {}): string {
  const { post, variants, approvals } = d;
  const lines: string[] = [];
  const title = post.title ? ` ${quote(post.title)}` : "";
  lines.push(`${opts.lead ? `${opts.lead} ` : ""}Post ${post.id}${title} — status: ${post.status}. ${describeStatus(post)}`);

  const decision = policyDecisionOf(post.policyDecision);
  if (decision && decision.violations.length > 0) {
    lines.push(
      post.status === "blocked"
        ? `Red-line violations (${decision.violations.length}):`
        : `Flagged by red lines (${decision.violations.length}); a human will see these:`,
    );
    lines.push(formatViolations(decision.violations));
  }
  if (decision?.autonomy) lines.push(`Autonomy that applied: ${AUTONOMY_TEXT[decision.autonomy] ?? decision.autonomy}.`);

  lines.push(`Variants (${variants.length}):`);
  for (const v of variants) {
    const thread = v.thread && v.thread.length > 0 ? ` +${plural(v.thread.length, "thread segment")}` : "";
    const url = v.externalUrl ? ` → ${v.externalUrl}` : "";
    const err = v.error ? ` error: ${v.error}` : "";
    lines.push(`  - ${v.network} (account ${v.socialAccountId}) [${v.status}]: ${quote(excerpt(v.text, 220))}${thread}${url}${err}`);
  }
  lines.push(`Approvals: ${approvals.length === 0 ? "none yet" : approvals.map((a) => `${a.state}${a.note ? ` (${quote(a.note)})` : ""}`).join(", ")}.`);
  const trend = post.trendTopicId ? `; trend topic ${post.trendTopicId}${post.trendStageAtCreation ? ` at stage ${post.trendStageAtCreation}` : ""}` : "";
  lines.push(`Created by ${actorLabel(post.createdBy)} at ${when(post.createdAt)}; action class ${post.actionClass}${trend}.`);
  if (post.disclosure) {
    lines.push(
      `Disclosure: AI-assisted ${post.disclosure.aiAssisted ? "yes" : "no"}${post.disclosure.aiContributions?.length ? ` (${post.disclosure.aiContributions.join(", ")})` : ""}, human reviewed ${post.disclosure.humanReviewed ? "yes" : "not yet"}${post.disclosure.model ? `, model ${post.disclosure.model}` : ""}.`,
    );
  }
  if (opts.history) {
    lines.push(`History (${plural(opts.history.length, "ledger event")}):`);
    lines.push(opts.history.length === 0 ? "  (none)" : opts.history.map((e) => `  - #${e.seq} ${when(e.occurredAt)} ${e.type} by ${actorLabel(e.actor)}${e.data && Object.keys(e.data).length > 0 ? ` ${compactJson(e.data)}` : ""}`).join("\n"));
  }
  return lines.join("\n");
}

function postLine(item: PostSummary): string {
  const { post, variants } = item;
  const networks = variants.map((v) => v.network).join(",") || "no variants";
  const text = excerpt(variants[0]?.text ?? post.body, 120);
  const sched = post.scheduledAt ? `, scheduled ${when(post.scheduledAt)}` : "";
  return `  - ${post.id} [${post.status}] ${networks} by ${actorLabel(post.createdBy)} ${when(post.createdAt)}${sched}: ${quote(text)}`;
}

export function formatQueue(items: PostSummary[]): string {
  if (items.length === 0) return "The approval queue is empty: nothing is waiting on a human.";
  return [`${plural(items.length, "post")} waiting on a human, oldest first. Humans approve or reject in the base air app; this server cannot decide for them.`, ...items.map(postLine)].join("\n");
}

export function formatPostList(items: PostSummary[]): string {
  if (items.length === 0) return "No posts matched.";
  return [`${plural(items.length, "post")}, newest first:`, ...items.map(postLine)].join("\n");
}

// ---- trends ----------------------------------------------------------------------------------

export function formatRadar(entries: RadarEntry[]): string {
  if (entries.length === 0) return "The radar is empty: no trend topics are tracked for this workspace yet (topics are added in the base air app).";
  const rows = entries.map((e) => [
    e.topic.name,
    e.topic.id,
    e.forecast?.stage ?? "no forecast",
    pct(e.forecast?.confidence),
    hoursLabel(e.forecast?.hoursToPeak),
    e.window ?? "—",
    String(e.actedOn),
  ]);
  return [
    `Trend radar: ${plural(entries.length, "topic")}, best score first.`,
    table(["Topic", "Id", "Stage", "Confidence", "Peak in", "Window", "Acted on"], rows),
    "Use get_topic <id> for the series and past outcomes. When you act on a topic, pass trendTopicId, trendStageAtCreation and trendForecastId (in the JSON below) to create_post so the ledger records which stage you acted in.",
  ].join("\n");
}

export function formatTopic(t: TopicDetail): string {
  const lines: string[] = [];
  lines.push(`Topic ${quote(t.topic.name)} (id ${t.topic.id}); keywords: ${t.topic.keywords.join(", ") || "—"}; relevance to this brand ${pct(t.topic.relevance)}.`);
  if (t.forecast) {
    const f = t.forecast;
    lines.push(
      `Forecast ${f.id} (computed ${when(f.computedAt)}): stage ${f.stage}, confidence ${pct(f.confidence)}, velocity ${f.velocity.toFixed(2)}/h, peak in ${hoursLabel(f.hoursToPeak)}; sources ${f.sources.join(", ") || "—"} (agreement ${pct(f.sourceAgreement)}); ${plural(f.curve.length, "curve point")} with lo/hi band.`,
    );
  } else {
    lines.push("No forecast yet.");
  }
  lines.push(
    t.series.length === 0
      ? "Series: none recorded."
      : `Series: ${t.series
          .map((s) => {
            const last = s.points[s.points.length - 1];
            return `${s.source} (${plural(s.points.length, "point")}${last ? `, latest ${num(last.v)} at ${when(last.t)}` : ""})`;
          })
          .join("; ")}.`,
  );
  if (t.actions.length === 0) {
    lines.push("The brand has not acted on this topic yet.");
  } else {
    lines.push(`Actions (${plural(t.actions.length, "post")} created against this topic):`);
    for (const a of t.actions) {
      lines.push(`  - ${a.postId} at ${when(a.createdAt)}, stage ${a.stageAtAction ?? "unknown"}${a.outcome24h ? `; 24h outcome ${compactJson(a.outcome24h)}` : "; 24h outcome pending"}`);
    }
  }
  return lines.join("\n");
}

// ---- feed ------------------------------------------------------------------------------------

export function formatFeed(items: Activity[]): string {
  if (items.length === 0) return "No activity matched.";
  return [
    `${plural(items.length, "activity item")}, newest first:`,
    ...items.map((a) => {
      const who = a.authorHandle ? `@${a.authorHandle}` : (a.authorName ?? "unknown author");
      const sentiment = a.sentiment !== null && a.sentiment !== undefined ? ` (sentiment ${a.sentiment.toFixed(2)})` : "";
      const url = a.url ? ` ${a.url}` : "";
      return `  - ${when(a.occurredAt)} ${a.network} ${a.kind} ${who}${sentiment}: ${quote(excerpt(a.text, 200))}${url} [id ${a.id}]`;
    }),
  ].join("\n");
}

// ---- measurement -----------------------------------------------------------------------------

function groupTable(groups: MetricsGroup[], keyHeader: string, baseline: number | null): string {
  return table(
    [keyHeader, "Posts", "Impressions", "Engagements", "Avg eng", "Lift"],
    groups.map((g) => [g.key, String(g.posts), num(g.impressions), num(g.engagements), num(g.avgEngagements), liftLabel(baseline ? g.avgEngagements / baseline : null)]),
  );
}

export function formatSummary(s: MetricsSummary, range: { from: Date; to: Date; days: number }): string {
  const lines: string[] = [];
  lines.push(`Outcomes for the last ${plural(range.days, "day")} (${when(range.from.toISOString())} → ${when(range.to.toISOString())}).`);
  lines.push(
    `Totals: ${num(s.totals.impressions)} impressions, ${num(s.totals.engagements)} engagements; ${plural(s.measuredAt24h, "variant")} measured at 24h; baseline ${num(s.baselineEngagements24h)} engagements per post per 24h (lift = avg ÷ baseline).`,
  );
  lines.push(`Published by network: ${s.publishedByNetwork.length === 0 ? "nothing published in this window" : s.publishedByNetwork.map((p) => `${p.network} ${p.posts}`).join(", ")}.`);
  if (s.byNetwork.length > 0) lines.push("By network:", groupTable(s.byNetwork, "Network", s.baselineEngagements24h));
  if (s.byTrendStage.length > 0) lines.push("By trend stage at creation:", groupTable(s.byTrendStage, "Stage", s.baselineEngagements24h));
  if (s.byExperiment.length > 0) lines.push("By experiment arm:", groupTable(s.byExperiment, "Arm", s.baselineEngagements24h));
  if (s.top.length > 0) {
    lines.push("Top posts:");
    for (const t of s.top) lines.push(`  - ${t.network} ${num(t.engagements)} engagements, ${num(t.impressions)} impressions, lift ${liftLabel(t.lift)}: ${quote(excerpt(t.text, 120))} [post ${t.postId}]`);
  }
  lines.push("byHour and byAuthor are in the JSON below.");
  return lines.join("\n");
}

export function formatLift(rows: LiftByStage[], days: number): string {
  if (rows.length === 0) return `No published posts with trend context in the last ${plural(days, "day")}, so there is no lift by stage yet.`;
  return [
    `Lift by trend stage at creation, last ${plural(days, "day")} (lift = avg engagements ÷ 24h baseline; 1.00x = baseline):`,
    table(["Stage", "Posts", "Avg engagements", "Lift"], rows.map((r) => [r.stage, String(r.posts), num(r.avgEngagements), liftLabel(r.lift)])),
  ].join("\n");
}

// ---- operators' output -----------------------------------------------------------------------

export function formatBrief(b: Brief | null): string {
  if (!b) return "No brief has been written yet.";
  return `Latest brief, covering ${when(b.periodStart)} → ${when(b.periodEnd)} (written ${when(b.createdAt)}, id ${b.id}):\n\n${b.contentMd}`;
}

export function formatAlerts(alerts: Alert[], unacknowledgedOnly: boolean): string {
  if (alerts.length === 0) return unacknowledgedOnly ? "No unacknowledged alerts." : "No alerts.";
  return [
    `${plural(alerts.length, "alert")}${unacknowledgedOnly ? " awaiting acknowledgement" : ""} (acknowledging happens in the base air app):`,
    ...alerts.map((a) => {
      const meta = [a.kind, when(a.createdAt), a.acknowledgedAt ? "acknowledged" : "unacknowledged", a.topicId ? `topic ${a.topicId}` : ""].filter(Boolean).join(", ");
      return `  - [${a.severity.toUpperCase()}] ${a.title} (${meta}) [id ${a.id}]${a.body ? `\n      ${excerpt(a.body, 240)}` : ""}`;
    }),
  ].join("\n");
}

// ---- ledger ----------------------------------------------------------------------------------

export function formatLedger(events: LedgerEvent[]): string {
  if (events.length === 0) return "No ledger events matched.";
  return [
    `${plural(events.length, "ledger event")}, newest first:`,
    ...events.map((e) => `  - #${e.seq} ${when(e.occurredAt)} ${e.type} ${e.subjectType}/${e.subjectId} by ${actorLabel(e.actor)}${e.data && Object.keys(e.data).length > 0 ? ` ${compactJson(e.data)}` : ""}`),
  ].join("\n");
}

// ---- brand context ---------------------------------------------------------------------------

const KNOWN_PROFILE_KEYS = new Set(["description", "audience", "topics", "voice", "competitors"]);

export function formatContext(ctx: BrandContext): string {
  const { workspace, policy, accounts, voiceExamples, activeTopics, recentTop } = ctx;
  const profile = workspace.profile ?? {};
  const lines: string[] = [];

  lines.push(`# ${workspace.name}`);
  lines.push(profile.description ? profile.description : "(no brand description yet)");
  if (profile.audience) lines.push(`Audience: ${profile.audience}`);
  if (profile.topics && profile.topics.length > 0) lines.push(`Topics the brand speaks to: ${profile.topics.join(", ")}`);
  if (profile.voice) {
    if (profile.voice.do && profile.voice.do.length > 0) lines.push(`Voice, do: ${profile.voice.do.join("; ")}`);
    if (profile.voice.dont && profile.voice.dont.length > 0) lines.push(`Voice, don't: ${profile.voice.dont.join("; ")}`);
    if (profile.voice.examples && profile.voice.examples.length > 0) lines.push(`Voice examples from the profile:\n${profile.voice.examples.map((e) => `  - ${quote(e)}`).join("\n")}`);
  }
  if (profile.competitors && profile.competitors.length > 0) lines.push(`Competitors (never mention unless policy allows): ${profile.competitors.join(", ")}`);
  const extra = Object.entries(profile).filter(([k]) => !KNOWN_PROFILE_KEYS.has(k));
  if (extra.length > 0) lines.push(`Other profile fields: ${compactJson(Object.fromEntries(extra), 400)}`);

  lines.push("", "## Your autonomy (what you may do without a human), per action class");
  lines.push(formatAutonomy(policy.autonomy));
  lines.push(`Red lines (${policy.redLines.length}), enforced server-side on every post; a hard stop is final:`);
  lines.push(policy.redLines.length === 0 ? "  (none declared)" : policy.redLines.map((r) => `  - [${SEVERITY_TEXT[r.severity] ?? r.severity}] ${r.description} (${r.kind}, id ${r.id})`).join("\n"));
  lines.push(`Brand timezone: ${policy.timezone}. Use get_policy for the full parameters of each red line.`);

  lines.push("", "## Connected accounts (use the id as socialAccountId in create_post)");
  lines.push(
    accounts.length === 0
      ? "  (no accounts connected; nothing can be posted until a human connects one in the app)"
      : accounts.map((a) => `  - ${a.network} @${a.handle}${a.displayName ? ` (${a.displayName})` : ""}: id ${a.id}, ${a.status}${a.status !== "active" ? " — do not target this account" : ""}`).join("\n"),
  );

  lines.push("", "## Voice examples: what humans changed before approving earlier drafts (write like the \"after\")");
  lines.push(
    voiceExamples.length === 0
      ? "  (no approval edits yet)"
      : voiceExamples
          .slice(0, 20)
          .map((v, i) => `  ${i + 1}. before: ${quote(excerpt(v.before, 200))}\n     after:  ${quote(excerpt(v.after, 200))}`)
          .join("\n"),
  );

  lines.push("", "## Active topics (top of the radar)");
  lines.push(
    activeTopics.length === 0
      ? "  (no topics tracked yet)"
      : table(
          ["Topic", "Id", "Stage", "Confidence", "Peak in", "Window", "Acted on"],
          activeTopics.map((e) => [e.topic.name, e.topic.id, e.forecast?.stage ?? "no forecast", pct(e.forecast?.confidence), hoursLabel(e.forecast?.hoursToPeak), e.window ?? "—", String(e.actedOn)]),
        ),
  );

  if (recentTop && recentTop.length > 0) {
    lines.push("", "## Recent top posts (what worked)");
    lines.push(recentTop.map((t) => `  - ${t.network}: ${num(t.engagements)} engagements, lift ${liftLabel(t.lift)}: ${quote(excerpt(t.text, 120))}`).join("\n"));
  }

  lines.push("", "Next: draft in the brand's voice, dry-run with check_policy, then create_post. Whatever you create lands where the autonomy above says (usually the approval queue); humans decide in the app.");
  return lines.join("\n");
}
