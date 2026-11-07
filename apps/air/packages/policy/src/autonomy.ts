import { AUTONOMY_ORDER, type ActionClass, type ActorType, type AutonomyLevel, type Policy } from "@base-air/schema";

export type MemberRole = "owner" | "approver" | "editor" | "viewer";

export interface AutonomyResolution {
  /** The level that applies to this actor for this action. Humans are treated as "autopost" subject to role rules. */
  level: AutonomyLevel;
  /** Whether a human approval step is required before anything publishes. */
  requiresApproval: boolean;
  /** Whether the actor may even create the post. */
  mayCreate: boolean;
  /** Whether the actor may set a schedule time. */
  maySchedule: boolean;
  reason: string;
}

export function atLeast(level: AutonomyLevel, min: AutonomyLevel): boolean {
  return AUTONOMY_ORDER.indexOf(level) >= AUTONOMY_ORDER.indexOf(min);
}

/**
 * Resolve what an actor may do for an action class under a policy.
 * Operators and MCP-connected agents follow the autonomy dial. Humans follow role rules.
 */
export function resolveAutonomy(
  policy: Policy,
  actionClass: ActionClass,
  actorType: ActorType,
  role?: MemberRole,
): AutonomyResolution {
  if (actorType === "human") {
    if (role === "viewer") {
      return { level: "suggest", requiresApproval: true, mayCreate: false, maySchedule: false, reason: "viewers cannot create" };
    }
    const needsApprover = role === "editor" && policy.requireApprovalForEditors;
    return {
      level: "autopost",
      requiresApproval: needsApprover,
      mayCreate: true,
      maySchedule: true,
      reason: needsApprover ? "editors require an approver under this policy" : "human with publishing rights",
    };
  }
  if (actorType === "system") {
    // System actions (retries, republish) inherit nothing new; they execute what was already approved.
    return { level: "autopost", requiresApproval: false, mayCreate: false, maySchedule: false, reason: "system executes approved work" };
  }
  const level = policy.autonomy[actionClass] ?? "suggest";
  return {
    level,
    requiresApproval: level !== "autopost",
    mayCreate: atLeast(level, "draft"),
    maySchedule: atLeast(level, "schedule_with_approval"),
    reason: `autonomy for ${actionClass} is ${level}`,
  };
}
