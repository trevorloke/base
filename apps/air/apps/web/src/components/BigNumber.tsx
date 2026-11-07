import type { ReactNode } from "react";

/** A number first, a short label second. Status reads as numbers, not sentences. */
export function BigNumber({ value, label, title, muted = false }: { value: ReactNode; label: string; title?: string; muted?: boolean }) {
  return (
    <div className={`bignum${muted ? " bignum-muted" : ""}`} title={title}>
      <span className="bignum-value mono">{value}</span>
      <span className="bignum-label">{label}</span>
    </div>
  );
}
