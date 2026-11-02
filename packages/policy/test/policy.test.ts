import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@starsign/schema";
import { evaluatePost, evaluateSubject, gatePost, resolveAutonomy } from "../src/index.ts";

const policy: Policy = {
  ...DEFAULT_POLICY,
  version: 3,
  redLines: [
    { id: "p1", kind: "forbidden_phrase", description: "No guarantees", severity: "block", phrases: ["guaranteed", "risk-free"] },
    { id: "t1", kind: "forbidden_topic", description: "Never comment on elections", severity: "block", keywords: ["election", "ballot"], semantic: true },
    { id: "c1", kind: "forbidden_claim", description: "No cure claims", severity: "block", patterns: ["cures? (cancer|covid|diabetes)"] },
    { id: "k1", kind: "no_competitor_mention", description: "Don't name competitors", severity: "require_approval", competitors: ["Hootsuite", "Sprinklr"] },
    { id: "q1", kind: "quiet_hours", description: "No posts overnight", severity: "require_approval", timezone: "America/Vancouver", startHour: 22, endHour: 6, days: [] },
    { id: "d1", kind: "required_disclosure", description: "Disclose AI", severity: "block", requiredText: "#AIassisted", when: "ai_assisted" },
    { id: "m1", kind: "max_posts_per_day", description: "Cadence cap", severity: "warn", limit: 3, networks: ["x"] },
    { id: "n1", kind: "network_restriction", description: "Not on TikTok", severity: "block", networks: ["tiktok"] },
  ],
};

const base = { network: "x", scheduledAt: new Date("2026-11-02T20:00:00Z") }; // 12:00 Vancouver (PST)

describe("red lines", () => {
  it("passes clean text", () => {
    const d = evaluateSubject(policy, { ...base, text: "A calm Monday update." });
    expect(d.verdict).toBe("allow");
    expect(d.violations).toHaveLength(0);
  });

  it("blocks forbidden phrases with word boundaries", () => {
    expect(evaluateSubject(policy, { ...base, text: "Results guaranteed!" }).verdict).toBe("block");
    expect(evaluateSubject(policy, { ...base, text: "unguaranteed wording" }).verdict).toBe("allow");
    expect(evaluateSubject(policy, { ...base, text: "RISK-FREE trial" }).violations[0]?.matches).toEqual(["RISK-FREE"]);
  });

  it("blocks forbidden topics by keyword and by semantic classifier", () => {
    expect(evaluateSubject(policy, { ...base, text: "Thoughts on the election" }).verdict).toBe("block");
    const d = evaluateSubject(
      policy,
      { ...base, text: "Who should run the country next year?" },
      { classifyTopic: () => 0.92 },
    );
    expect(d.verdict).toBe("block");
    expect(d.violations[0]?.message).toMatch(/semantic/);
  });

  it("blocks claim patterns", () => {
    expect(evaluateSubject(policy, { ...base, text: "This tea cures cancer" }).verdict).toBe("block");
  });

  it("requires approval for competitor mentions", () => {
    const d = evaluateSubject(policy, { ...base, text: "Better than Hootsuite" });
    expect(d.verdict).toBe("require_approval");
  });

  it("enforces quiet hours in the declared timezone", () => {
    const late = new Date("2026-11-03T07:30:00Z"); // 23:30 Vancouver
    expect(evaluateSubject(policy, { network: "x", text: "night owl", scheduledAt: late }).verdict).toBe("require_approval");
    const morning = new Date("2026-11-03T15:00:00Z"); // 07:00 Vancouver
    expect(evaluateSubject(policy, { network: "x", text: "morning", scheduledAt: morning }).verdict).toBe("allow");
  });

  it("requires disclosure when AI-assisted", () => {
    const disc = { aiAssisted: true, aiContributions: ["text_drafted"], humanReviewed: false };
    expect(evaluateSubject(policy, { ...base, text: "Drafted by a robot", disclosure: disc }).verdict).toBe("block");
    expect(evaluateSubject(policy, { ...base, text: "Drafted by a robot #AIassisted", disclosure: disc }).verdict).toBe("allow");
  });

  it("warns on cadence caps and blocks restricted networks", () => {
    const d = evaluateSubject(policy, { ...base, text: "fourth post" }, { postsToday: { x: 3 } });
    expect(d.verdict).toBe("allow");
    expect(d.violations[0]?.severity).toBe("warn");
    expect(evaluateSubject(policy, { ...base, network: "tiktok", text: "hi" }).verdict).toBe("block");
  });

  it("aggregates across variants with the worst verdict", () => {
    const d = evaluatePost(policy, [
      { ...base, text: "fine" },
      { ...base, network: "bluesky", text: "Better than Sprinklr" },
    ]);
    expect(d.verdict).toBe("require_approval");
    expect(d.violations[0]?.message).toMatch(/^\[bluesky\]/);
  });
});

describe("autonomy", () => {
  it("operators follow the dial", () => {
    const r = resolveAutonomy(policy, "dm", "operator");
    expect(r.mayCreate).toBe(false);
    const r2 = resolveAutonomy(policy, "new_post", "operator");
    expect(r2.mayCreate).toBe(true);
    expect(r2.maySchedule).toBe(true);
    expect(r2.requiresApproval).toBe(true);
  });

  it("humans follow roles", () => {
    expect(resolveAutonomy(policy, "new_post", "human", "owner").requiresApproval).toBe(false);
    expect(resolveAutonomy(policy, "new_post", "human", "editor").requiresApproval).toBe(true);
    expect(resolveAutonomy(policy, "new_post", "human", "viewer").mayCreate).toBe(false);
  });
});

describe("gate", () => {
  it("routes an operator's clean scheduled post to pending approval", () => {
    const g = gatePost({ policy, actionClass: "new_post", actorType: "operator", subjects: [{ ...base, text: "ok" }], wantsSchedule: true });
    expect(g.initialStatus).toBe("pending_approval");
  });

  it("lets an owner schedule directly, but still blocks red lines", () => {
    const ok = gatePost({ policy, actionClass: "new_post", actorType: "human", role: "owner", subjects: [{ ...base, text: "ok" }], wantsSchedule: true });
    expect(ok.initialStatus).toBe("scheduled");
    const bad = gatePost({ policy, actionClass: "new_post", actorType: "human", role: "owner", subjects: [{ ...base, text: "guaranteed" }], wantsSchedule: true });
    expect(bad.initialStatus).toBe("blocked");
  });

  it("refuses creation when autonomy is suggest-only", () => {
    const g = gatePost({ policy, actionClass: "dm", actorType: "mcp", subjects: [{ ...base, text: "hey" }], wantsSchedule: false });
    expect(g.initialStatus).toBeNull();
    expect(g.refusedReason).toMatch(/suggest/);
  });

  it("autopost with a clean subject schedules", () => {
    const p: Policy = { ...policy, autonomy: { ...policy.autonomy, reply: "autopost" } };
    const g = gatePost({ policy: p, actionClass: "reply", actorType: "operator", subjects: [{ ...base, text: "thanks!" }], wantsSchedule: true });
    expect(g.initialStatus).toBe("scheduled");
  });
});

describe("cadence counting", () => {
  it("counts the all-network total once when the red line has no network list", () => {
    const p: Policy = { ...DEFAULT_POLICY, redLines: [{ id: "m", kind: "max_posts_per_day", description: "cap", severity: "block", limit: 4, networks: [] }] };
    expect(evaluateSubject(p, { network: "x", text: "a", scheduledAt: null }, { postsToday: { x: 2, "*": 2 } }).verdict).toBe("allow");
    expect(evaluateSubject(p, { network: "x", text: "a", scheduledAt: null }, { postsToday: { x: 2, bluesky: 2, "*": 4 } }).verdict).toBe("block");
  });
});
