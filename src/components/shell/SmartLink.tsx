import Link from "next/link";
import type { ReactNode } from "react";

/** Internal paths go through next/link; anything else is a plain anchor. */
export function SmartLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={className}>
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
