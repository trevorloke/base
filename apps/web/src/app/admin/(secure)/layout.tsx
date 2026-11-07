import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { adminPreviewAllowed } from "@/lib/preview-mode";
import { can, getAdminAccount, ROLE_LABELS, type Permission } from "@/lib/server/admin-auth";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

// Every page under (secure) also calls requireAdmin itself: a layout check
// alone can be skipped by a direct request for the page segment.
const NAV: { href: string; label: string; permission?: Permission }[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/people", label: "Supporters", permission: "people" },
  { href: "/admin/shifts", label: "Volunteer shifts", permission: "shifts" },
  { href: "/admin/comms", label: "Email & text log", permission: "comms" },
  { href: "/admin/home", label: "Home page", permission: "settings" },
  { href: "/admin/content", label: "Content", permission: "content" },
  { href: "/admin/pages", label: "Pages", permission: "content" },
  { href: "/admin/media", label: "Media", permission: "content" },
  { href: "/admin/tracker", label: "Promise tracker", permission: "tracker" },
  { href: "/admin/desk-gifts", label: "Gifts to log at the desk", permission: "money" },
  { href: "/admin/limits", label: "Contribution limits", permission: "money" },
  { href: "/admin/settings", label: "Site settings", permission: "settings" },
  { href: "/admin/integrations", label: "Integrations", permission: "integrations" },
  { href: "/admin/exports", label: "Exports" },
  { href: "/admin/users", label: "Staff", permission: "users" },
  { href: "/admin/audit", label: "Audit log", permission: "users" },
  { href: "/admin/account", label: "My account" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const account = await getAdminAccount();
  if (!account) redirect("/admin/login");
  const { user, mustEnrol } = account;
  // Enrol first: an owner or administrator without two-factor sign-in gets
  // only My account (requireAdmin on every other page sends them there).
  const nav = mustEnrol ? NAV.filter((item) => item.href === "/admin/account") : NAV.filter((item) => !item.permission || can(user, item.permission));
  return (
    <div className="admin">
      {adminPreviewAllowed() && (
        <p role="status" className="no-print" style={{ margin: 0, padding: "8px 16px", background: "var(--yellow)", color: "var(--navy)", fontWeight: 700 }}>
          Preview mode: signed in automatically on this local copy. It cannot be turned on for the live site.
        </p>
      )}
      <nav className="admin-nav no-print" aria-label="Admin">
        <strong style={{ color: "var(--navy)", fontSize: 18 }}>Imagine Surrey admin</strong>
        {nav.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
        <span className="small" style={{ marginLeft: "auto" }}>
          {user.name} · {ROLE_LABELS[user.role]}
        </span>
        <form method="post" action="/api/admin/logout">
          <button type="submit" className="btn btn--outline" style={{ minHeight: 40 }}>
            Sign out
          </button>
        </form>
      </nav>
      {mustEnrol && (
        <div role="alert" className="alert no-print" style={{ margin: "16px 16px 0" }}>
          <span aria-hidden="true" className="alert-icon">
            !
          </span>
          <span>
            <strong>Set up two-factor sign-in to continue.</strong> The admin holds supporters&apos; personal and political information, so owners and administrators need a code from an authenticator app as well as a password. The rest of the admin opens once it&apos;s on.
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
