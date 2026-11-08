"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that shows it is working and blocks double submits, with
 * an optional confirmation for destructive actions. Keeps focus on itself
 * (aria-busy instead of disabled) so keyboard and screen-reader users don't
 * lose their place.
 */
export function SubmitButton({
  children,
  pendingText,
  confirm,
  className = "btn btn--primary",
  ...rest
}: { children: React.ReactNode; pendingText?: string; confirm?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type">) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      aria-busy={pending}
      aria-disabled={pending}
      onClick={(e) => {
        if (pending) {
          e.preventDefault();
          return;
        }
        if (confirm && !window.confirm(confirm)) e.preventDefault();
        rest.onClick?.(e);
      }}
      {...rest}
    >
      {pending ? (pendingText ?? "Saving…") : children}
    </button>
  );
}
