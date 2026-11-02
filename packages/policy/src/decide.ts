import type { ActionClass, ActorType, Policy, PolicyDecision, PostStatus } from "@meridian/schema";
import { resolveAutonomy, type MemberRole } from "./autonomy.ts";
import { evaluatePost, type EvaluationContext, type Subject } from "./redlines.ts";

export interface GateInput {
  policy: Policy;
  actionClass: ActionClass;
  actorType: ActorType;
  role?: MemberRole;
  subjects: Subject[];
  wantsSchedule: boolean;
  ctx?: EvaluationContext;
}

export interface GateResult {
  decision: PolicyDecision;
  /** The status a newly created post should start in, or null if creation is refused. */
  initialStatus: PostStatus | null;
  refusedReason?: string;
}

/**
 * The single gate every post passes through, whoever created it.
 * Combines red lines (content) with autonomy (who may do what).
 */
export function gatePost(input: GateInput): GateResult {
  const autonomy = resolveAutonomy(input.policy, input.actionClass, input.actorType, input.role);
  const decision = { ...evaluatePost(input.policy, input.subjects, input.ctx), autonomy: autonomy.level };

  if (!autonomy.mayCreate) {
    return { decision, initialStatus: null, refusedReason: autonomy.reason };
  }
  if (decision.verdict === "block") {
    return { decision, initialStatus: "blocked" };
  }
  const needsApproval = autonomy.requiresApproval || decision.verdict === "require_approval";
  if (needsApproval) {
    return { decision, initialStatus: "pending_approval" };
  }
  if (input.wantsSchedule) {
    return { decision, initialStatus: autonomy.maySchedule ? "scheduled" : "draft" };
  }
  return { decision, initialStatus: "draft" };
}
