"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/me", label: "Overview" },
  { href: "/me/preferences", label: "Preferences" },
  { href: "/me/data", label: "Your data" },
];

export function PortalNav() {
  const pathname = usePathname();
  return (
    <nav className="portal-nav" aria-label="Your account">
      <span className="portal-nav__brand">Your supporter home</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
      <form method="post" action="/api/me/logout">
        <button type="submit" className="btn btn--outline btn--sm">
          Sign out
        </button>
      </form>
    </nav>
  );
}
