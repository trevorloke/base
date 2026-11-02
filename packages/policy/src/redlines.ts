import type { Disclosure, Policy, PolicyDecision, PolicyVerdict, RedLine, Violation } from "@starsign/schema";
import { findPatterns, findPhrases } from "./text.ts";
import { hourInWindow, localHourAndDay } from "./time.ts";

/** The thing being judged. One variant at a time; the caller aggregates across variants. */
export interface Subject {
  text: string;
  network: string;
  /** When it will go out. Null = immediately / unknown. */
  scheduledAt: Date | null;
  disclosure?: Disclosure | null;
  flags?: { paid?: boolean };
}

/** Facts the evaluator cannot know from the subject alone. */
export interface EvaluationContext {
  /** Posts already published or scheduled on the same local day, per network ("*" = all). */
  postsToday?: Record<string, number>;
  /** Optional semantic classifier for forbidden_topic lines marked semantic. Returns 0..1 likelihood. */
  classifyTopic?: (text: string, topicKeywords: string[], description: string) => number;
  /** Threshold above which a semantic classification counts as a hit. */
  semanticThreshold?: number;
  now?: Date;
}

const SEVERITY_RANK: Record<Violation["severity"], number> = { warn: 0, require_approval: 1, block: 2 };

export function verdictFromViolations(violations: Violation[]): PolicyVerdict {
  let worst: Violation["severity"] | null = null;
  for (const v of violations) {
    if (worst === null || SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst]) worst = v.severity;
  }
  if (worst === "block") return "block";
  if (worst === "require_approval") return "require_approval";
  return "allow";
}

function violation(rl: RedLine, message: string, matches: string[] = []): Violation {
  return { redLineId: rl.id, kind: rl.kind, severity: rl.severity, message, matches };
}

export function evaluateRedLine(rl: RedLine, subject: Subject, ctx: EvaluationContext = {}): Violation | null {
  switch (rl.kind) {
    case "forbidden_phrase": {
      const hits = findPhrases(subject.text, rl.phrases);
      return hits.length ? violation(rl, `${rl.description}: contains forbidden phrase`, hits) : null;
    }
    case "forbidden_topic": {
      const hits = findPhrases(subject.text, rl.keywords);
      if (hits.length) return violation(rl, `${rl.description}: touches forbidden topic`, hits);
      if (rl.semantic && ctx.classifyTopic) {
        const score = ctx.classifyTopic(subject.text, rl.keywords, rl.description);
        if (score >= (ctx.semanticThreshold ?? 0.7)) {
          return violation(rl, `${rl.description}: semantic match (${score.toFixed(2)})`);
        }
      }
      return null;
    }
    case "forbidden_claim": {
      const hits = findPatterns(subject.text, rl.patterns);
      return hits.length ? violation(rl, `${rl.description}: makes a forbidden claim`, hits) : null;
    }
    case "no_competitor_mention": {
      const hits = findPhrases(subject.text, rl.competitors);
      return hits.length ? violation(rl, `${rl.description}: names a competitor`, hits) : null;
    }
    case "quiet_hours": {
      const at = subject.scheduledAt ?? ctx.now ?? new Date();
      const { hour, day } = localHourAndDay(at, rl.timezone);
      const dayApplies = rl.days.length === 0 || rl.days.includes(day);
      if (dayApplies && hourInWindow(hour, rl.startHour, rl.endHour)) {
        return violation(rl, `${rl.description}: falls inside quiet hours (${rl.startHour}:00-${rl.endHour}:00 ${rl.timezone})`);
      }
      return null;
    }
    case "required_disclosure": {
      const applies =
        rl.when === "always" ||
        (rl.when === "ai_assisted" && subject.disclosure?.aiAssisted === true) ||
        (rl.when === "paid" && subject.flags?.paid === true);
      if (!applies) return null;
      const present = findPhrases(subject.text, [rl.requiredText]).length > 0;
      return present ? null : violation(rl, `${rl.description}: missing required disclosure "${rl.requiredText}"`);
    }
    case "max_posts_per_day": {
      const applies = rl.networks.length === 0 || rl.networks.includes(subject.network);
      if (!applies) return null;
      const count = (ctx.postsToday?.[subject.network] ?? 0) + (rl.networks.length === 0 ? (ctx.postsToday?.["*"] ?? 0) : 0);
      return count >= rl.limit ? violation(rl, `${rl.description}: daily limit of ${rl.limit} reached (${count})`) : null;
    }
    case "network_restriction": {
      return rl.networks.includes(subject.network) ? violation(rl, `${rl.description}: ${subject.network} is restricted`) : null;
    }
    case "custom_regex": {
      const hits = findPatterns(subject.text, [rl.pattern], rl.flags);
      return hits.length ? violation(rl, rl.description, hits) : null;
    }
  }
}

/** Evaluate every red line against one subject. Order of violations is policy order. */
export function evaluateSubject(policy: Policy, subject: Subject, ctx: EvaluationContext = {}): PolicyDecision {
  const violations: Violation[] = [];
  for (const rl of policy.redLines) {
    const v = evaluateRedLine(rl, subject, ctx);
    if (v) violations.push(v);
  }
  return { verdict: verdictFromViolations(violations), violations, policyVersion: policy.version };
}

/** Evaluate a set of variants (one post, N networks). The worst verdict wins; violations are deduplicated by (redLine, network). */
export function evaluatePost(policy: Policy, subjects: Subject[], ctx: EvaluationContext = {}): PolicyDecision {
  const all: Violation[] = [];
  const seen = new Set<string>();
  for (const s of subjects) {
    const d = evaluateSubject(policy, s, ctx);
    for (const v of d.violations) {
      const key = `${v.redLineId}|${s.network}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...v, message: `[${s.network}] ${v.message}` });
    }
  }
  return { verdict: verdictFromViolations(all), violations: all, policyVersion: policy.version };
}
