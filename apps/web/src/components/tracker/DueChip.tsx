import type { DueInfo } from "@/lib/tracker";

/** The countdown or overdue flag for a promise, as a small chip. */
export function DueChip({ info, large }: { info: DueInfo | null; large?: boolean }) {
  if (!info) return null;
  return (
    <span className={`due-chip due-chip--${info.kind}${large ? " due-chip--large" : ""}`}>
      {info.kind === "overdue" && (
        <span aria-hidden="true" className="due-chip-mark">
          !
        </span>
      )}
      {info.label}
    </span>
  );
}
