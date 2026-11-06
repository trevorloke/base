import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A quiet popover: a button that opens a small panel under it. Escape, a click outside, or picking an item
 * closes it. `children` gets `close` so items can dismiss the menu after acting.
 */
export function Menu({
  label,
  ariaLabel,
  className,
  buttonClassName = "btn btn-ghost",
  align = "left",
  children,
}: {
  label: ReactNode;
  ariaLabel?: string;
  className?: string;
  buttonClassName?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu${className ? ` ${className}` : ""}`} ref={root}>
      <button type="button" className={buttonClassName} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open ? (
        <div className={`menu-pop menu-pop-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
