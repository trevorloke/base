import type { ReactNode } from "react";
import type { TrendStage } from "../types";
import { STAGE_LABEL } from "../lib/format";

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
