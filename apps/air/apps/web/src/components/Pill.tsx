import type { ReactNode } from "react";
import type { EntityRelation, TrendStage } from "../types";
import { RELATION_HINT, RELATION_LABEL, STAGE_LABEL } from "../lib/format";
import { RELATION_TONE } from "../lib/tracker";

export type PillTone = TrendStage | "neutral" | "good" | "warn" | "bad" | "info" | "accent";

export function Pill({ tone = "neutral", children, title, className }: { tone?: PillTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`pill pill-${tone}${className ? ` ${className}` : ""}`} title={title}>
      {children}
    </span>
  );
}

export function StagePill({ stage, title }: { stage: TrendStage; title?: string }) {
  return (
    <Pill tone={stage} title={title}>
      {STAGE_LABEL[stage]}
    </Pill>
  );
}

/** Own, client, prospect, competitor, opponent, watching: tinted quietly. */
export function RelationPill({ relation }: { relation: EntityRelation }) {
  return (
    <Pill tone={RELATION_TONE[relation] ?? "neutral"} title={RELATION_HINT[relation]} className="rel-pill">
      {RELATION_LABEL[relation] ?? relation}
    </Pill>
  );
}
