import type { ActionClass, AutonomyLevel, Policy, RedLine, RedLineKind, RedLineSeverity } from "../types";
import { ACTION_CLASS_LABEL, ACTION_CLASS_ORDER, AUTONOMY_LABEL, listOf, networkLabel, SEVERITY_LABEL } from "./format";
import { tzName } from "./tz";

/** The Settings drawer's sections; links elsewhere open it at one of them. */
export type SettingsSectionId = "brand" | "redlines" | "autonomy" | "timezone" | "spend" | "history";

/** Every red line kind the schema knows, in the order the form offers them. */
export const RED_LINE_KINDS: RedLineKind[] = [
  "forbidden_phrase",
  "forbidden_topic",
  "forbidden_claim",
  "no_competitor_mention",
  "quiet_hours",
  "required_disclosure",
  "max_posts_per_day",
  "network_restriction",
  "custom_regex",
];

export const RED_LINE_KIND_LABEL: Record<RedLineKind, string> = {
  forbidden_phrase: "Forbidden phrase",
  forbidden_topic: "Forbidden topic",
  forbidden_claim: "Forbidden claim pattern",
  no_competitor_mention: "Competitor mention",
  quiet_hours: "Quiet hours",
  required_disclosure: "Required disclosure",
  max_posts_per_day: "Post cap",
  network_restriction: "Network restriction",
  custom_regex: "Custom pattern",
};

export const RED_LINE_KIND_HINT: Record<RedLineKind, string> = {
  forbidden_phrase: "Words or phrases a post must never contain. Whole words, any case.",
  forbidden_topic: "A subject the brand stays out of, spotted by keywords and, if you like, by meaning.",
  forbidden_claim: "Shapes of claims never to make, written as patterns (regular expressions).",
  no_competitor_mention: "Names a post must never mention.",
  quiet_hours: "Hours when nothing goes out.",
  required_disclosure: "Text that must appear in some or all posts, such as #ad or #AIassisted.",
  max_posts_per_day: "The most posts a day, on all networks or some.",
  network_restriction: "Networks this workspace never posts to.",
  custom_regex: "One regular expression a post must not match.",
};

export function redLineKindLabel(kind: string): string {
  return (RED_LINE_KIND_LABEL as Record<string, string>)[kind] ?? kind.replace(/_/g, " ");
}

export const SEVERITIES: RedLineSeverity[] = ["block", "require_approval", "warn"];

export const SEVERITY_CHOICE: Record<RedLineSeverity, { label: string; hint: string }> = {
  block: { label: "Block", hint: "It never goes out, whoever wrote it." },
  require_approval: { label: "Needs approval", hint: "A person has to approve it first." },
  warn: { label: "Warn", hint: "It goes out; the warning is recorded." },
};

export const AUTONOMY_LEVELS: AutonomyLevel[] = ["suggest", "draft", "schedule_with_approval", "autopost"];

/** One line per dial value, from the schema's own definitions. */
export const AUTONOMY_HINT: Record<AutonomyLevel, string> = {
  suggest: "Agents may only surface ideas; nothing is created.",
  draft: "Agents may write drafts; a person schedules them.",
  schedule_with_approval: "Agents may schedule, but nothing goes out until someone approves it.",
  autopost: "Agents may publish on their own, still inside the red lines.",
};

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DISCLOSURE_WHEN: Record<string, string> = {
  ai_assisted: "AI-assisted posts",
  always: "every post",
  paid: "paid posts",
};

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const quoted = (xs: string[]) => xs.map((x) => `“${x}”`).join(", ");

/** What a red line holds, in a short phrase: "“guaranteed”, “guarantee”", "22:00–07:00 Pacific Time, every day". */
export function redLineDetail(r: RedLine): string {
  switch (r.kind) {
    case "forbidden_phrase":
      return quoted(strings(r.phrases));
    case "forbidden_topic":
      return `${quoted(strings(r.keywords))}${r.semantic ? " · also by meaning" : ""}`;
    case "forbidden_claim":
      return strings(r.patterns)
        .map((p) => `/${p}/`)
        .join(", ");
    case "custom_regex":
      return `/${String(r.pattern ?? "")}/${String(r.flags ?? "i")}`;
    case "no_competitor_mention":
      return strings(r.competitors).join(", ");
    case "quiet_hours": {
      const days = Array.isArray(r.days) ? (r.days as number[]) : [];
      const tz = typeof r.timezone === "string" ? r.timezone : "UTC";
      return `${hh(Number(r.startHour))}–${hh(Number(r.endHour))} ${tzName(tz)}, ${days.length ? days.map((d) => DAY_SHORT[d] ?? d).join(" ") : "every day"}`;
    }
    case "required_disclosure":
      return `“${String(r.requiredText ?? "")}” in ${DISCLOSURE_WHEN[String(r.when)] ?? String(r.when)}`;
    case "max_posts_per_day": {
      const nets = strings(r.networks);
      return `${Number(r.limit)} a day${nets.length ? ` on ${listOf(nets.map(networkLabel))}` : " across all networks"}`;
    }
    case "network_restriction":
      return `never ${listOf(strings(r.networks).map(networkLabel))}`;
    default:
      return "";
  }
}

/** The pattern a regex red line would compile, the way the server does (`u` always added). */
export function compilePattern(pattern: string, flags = "i"): { re: RegExp | null; error: string | null } {
  const f = [...new Set((flags.includes("u") ? flags : `${flags}u`).replace(/[^dgimsuy]/g, "").split(""))].join("").replace("g", "");
  try {
    return { re: new RegExp(pattern, f), error: null };
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "Not a valid pattern" };
  }
}

// --- History ---------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const money = (n: number | undefined) => (typeof n === "number" ? `$${n.toLocaleString()}` : "—");

/** What changed from one policy version to the next, in short sentences. */
export function policyDiff(prev: Policy | null, next: Policy): string[] {
  if (!prev) return ["First version"];
  const out: string[] = [];
  const before = new Map(prev.redLines.map((r) => [r.id, r]));
  const after = new Map(next.redLines.map((r) => [r.id, r]));
  for (const r of next.redLines) {
    const old = before.get(r.id);
    if (!old) out.push(`Added red line: ${r.description || redLineKindLabel(r.kind)}`);
    else if (!sameJson(old, r)) {
      const what = old.severity !== r.severity ? ` (${SEVERITY_LABEL[old.severity]} → ${SEVERITY_LABEL[r.severity]})` : "";
      out.push(`Changed red line: ${r.description || redLineKindLabel(r.kind)}${what}`);
    }
  }
  for (const r of prev.redLines) if (!after.has(r.id)) out.push(`Removed red line: ${r.description || redLineKindLabel(r.kind)}`);
  for (const c of ACTION_CLASS_ORDER as ActionClass[]) {
    const a = prev.autonomy[c];
    const b = next.autonomy[c];
    if (a !== b) out.push(`${ACTION_CLASS_LABEL[c]}: ${a ? AUTONOMY_LABEL[a] : "—"} → ${b ? AUTONOMY_LABEL[b] : "—"}`);
  }
  if (prev.requireApprovalForEditors !== next.requireApprovalForEditors) {
    out.push(next.requireApprovalForEditors ? "Editors now need an approver" : "Editors no longer need an approver");
  }
  if (prev.timezone !== next.timezone) out.push(`Timezone: ${prev.timezone} → ${next.timezone}`);
  const pc = prev.spendCaps;
  const nc = next.spendCaps;
  if (pc?.modelUsdMonthly !== nc?.modelUsdMonthly) out.push(`Model spend cap: ${money(pc?.modelUsdMonthly)} → ${money(nc?.modelUsdMonthly)} a month`);
  if (pc?.xReadsUsdMonthly !== nc?.xReadsUsdMonthly) out.push(`X reads cap: ${money(pc?.xReadsUsdMonthly)} → ${money(nc?.xReadsUsdMonthly)} a month`);
  if (!sameJson(prev.competitors ?? [], next.competitors ?? [])) out.push(`Competitors: ${listOf(next.competitors ?? []) || "none"}`);
  if (!sameJson(prev.disclosure ?? null, next.disclosure ?? null)) out.push("Disclosure settings changed");
  return out.length ? out : ["Saved with no changes"];
}
