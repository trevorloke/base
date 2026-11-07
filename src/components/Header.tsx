"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MenuIcon, SignInIcon } from "@/components/Icons";
import { nav } from "@/content/site";

function isCurrent(pathname: string, href: string): boolean {
  if (href.includes("#") || /^https?:/.test(href)) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type HeaderLink = { label: string; href: string };

/** A site path goes through the router; anything else is a plain link. */
function BarLink({ href, className, current, children }: { href: string; className: string; current?: "page"; children: React.ReactNode }) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={className} aria-current={current}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

/**
 * The title bar, kept deliberately plain: the logo, any links chosen in
 * Site settings → Title bar (none by default), one call to action and a
 * Menu button that opens every section of the site.
 */
export function Header({ links = [], cta = { label: "Donate", href: "/donate" } }: { links?: HeaderLink[]; cta?: HeaderLink }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "/";
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the menu whenever the page changes.
  useEffect(() => setOpen(false), [pathname]);

  // Escape closes the menu and puts focus back on the button that opened it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const current = (href: string) => (isCurrent(pathname, href) ? ("page" as const) : undefined);

  return (
    <header className="site-header">
      <nav className="site-nav" aria-label="Main">
        <Link href="/" className="logo-link" aria-current={pathname === "/" ? "page" : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the logo animates its height on scroll */}
          <img src="/images/logo.webp" alt="Imagine Surrey" className="logo" width={997} height={474} />
        </Link>
        <div className="nav-bar">
          {links.map((item) => (
            <BarLink key={item.href + item.label} href={item.href} className="nav-link nav-bar-link" current={current(item.href)}>
              {item.label}
            </BarLink>
          ))}
          {cta.label && cta.href && (
            <BarLink href={cta.href} className="btn btn--red nav-cta" current={current(cta.href)}>
              {cta.label}
            </BarLink>
          )}
          <button ref={toggleRef} type="button" className="btn btn--outline menu-toggle" aria-expanded={open} aria-controls="nav-links" onClick={() => setOpen((o) => !o)}>
            <MenuIcon open={open} />
            Menu
          </button>
        </div>
        <div className="nav-links" id="nav-links" data-open={open} onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          {/* On a phone the title-bar links move in here. */}
          {links.map((item) => (
            <BarLink key={`panel-${item.href}${item.label}`} href={item.href} className="nav-link nav-panel-extra" current={current(item.href)}>
              {item.label}
            </BarLink>
          ))}
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={current(item.href)}>
              {item.label}
            </Link>
          ))}
          <Link href="/me" className="nav-link nav-signin" aria-current={current("/me")}>
            <SignInIcon />
            Supporter sign-in
          </Link>
        </div>
      </nav>
    </header>
  );
}
