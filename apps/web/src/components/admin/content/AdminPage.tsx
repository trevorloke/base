import Link from "next/link";
import type { ReactNode } from "react";
import "@/app/admin/(secure)/content/content.css";

/** The shell every content page uses: a title row with actions, breadcrumbs back to the hub. */
export function AdminPage({
  title,
  eyebrow,
  intro,
  actions,
  crumbs,
  children,
}: {
  title: ReactNode;
  eyebrow?: string;
  intro?: ReactNode;
  actions?: ReactNode;
  crumbs?: { href: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <div className="cms">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <p className="cms-crumbs">
            {crumbs.map((c, i) => (
              <span key={c.href}>
                {i > 0 && " › "}
                <Link href={c.href}>{c.label}</Link>
              </span>
            ))}
          </p>
        </nav>
      )}
      <header className="cms-head">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="h3 cms-title">{title}</h1>
          {intro && <p className="cms-intro">{intro}</p>}
        </div>
        {actions && <div className="btn-row">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** A "saved" note shown after a redirect from create → edit. */
export function SavedNotice({ saved }: { saved?: string | string[] }) {
  const value = Array.isArray(saved) ? saved[0] : saved;
  if (!value) return null;
  const text = value === "created" ? "Saved. You can keep editing below." : "Saved.";
  return (
    <div role="status" className="alert alert--note">
      <span aria-hidden="true" className="alert-icon">
        ✓
      </span>
      <span>{text}</span>
    </div>
  );
}
