import type { ReactNode, TextareaHTMLAttributes } from "react";

/** A labelled textarea with an error line, matching TextField in src/components/forms/Field.tsx. */
export function TextareaField({
  id,
  label,
  error,
  hint,
  className,
  ...textarea
}: { id: string; label: ReactNode; error?: string; hint?: ReactNode; className?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p className="hint" id={`${id}-hint`} style={{ margin: 0 }}>
          {hint}
        </p>
      )}
      <textarea id={id} className="input input--area" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...textarea} />
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/** A status pill for drafts, scheduled posts, published items and so on. */
export function Badge({ tone, children }: { tone: "draft" | "scheduled" | "live" | "off" | "warn"; children: ReactNode }) {
  return <span className={`cms-badge cms-badge--${tone}`}>{children}</span>;
}
