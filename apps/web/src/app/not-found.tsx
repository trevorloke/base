import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

const PLACES = [
  { href: "/", label: "Home page" },
  { href: "/tracker", label: "Promise tracker" },
  { href: "/act", label: "Petitions and pledges" },
  { href: "/events", label: "Events" },
  { href: "/volunteer", label: "Volunteer" },
  { href: "/news", label: "News" },
  { href: "/donate", label: "Donate" },
];

export default function NotFound() {
  return (
    <>
      <PageHead title="Page not found">We couldn&apos;t find that page. It may have moved, or the link may have a typo.</PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 24 }}>
          <h2 className="h3">Try one of these instead</h2>
          <ul className="link-list" role="list">
            {PLACES.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="text-link">
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="btn-row">
            <Link href="/#join" className="btn btn--red btn--lg">
              Become a member
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
