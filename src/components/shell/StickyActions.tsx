"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const HIDDEN_UNDER = ["/admin", "/me"];

/**
 * The phone-width action bar: Act, Join, Give. Not shown in the admin or the
 * supporter area, where it would get in the way of their own controls.
 */
export function StickyActions() {
  const pathname = usePathname() ?? "/";
  if (HIDDEN_UNDER.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  return (
    <>
      <div className="sticky-actions-spacer" aria-hidden="true" />
      <nav className="sticky-actions" aria-label="Quick actions">
        <Link href="/act" className="sticky-action">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4z" />
            <path d="M13.5 6.5l4 4" />
          </svg>
          Act
        </Link>
        <Link href="/#join" className="sticky-action">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" />
          </svg>
          Join
        </Link>
        <Link href="/donate" className="sticky-action sticky-action--give">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" />
          </svg>
          Give
        </Link>
      </nav>
    </>
  );
}
