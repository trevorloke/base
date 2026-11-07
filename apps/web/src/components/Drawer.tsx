import { useEffect, type ReactNode } from "react";

/** Detail opens over the room, from the right. Never a new page. Escape or the backdrop closes it. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body: where a drawer's one primary action lives. */
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className={`drawer${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"}>
        <header className="drawer-head">
          <div className="drawer-titles">
            <h2 className="drawer-title">{title}</h2>
            {subtitle ? <div className="drawer-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}
