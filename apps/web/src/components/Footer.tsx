import Image from "next/image";
import Link from "next/link";
import { Markdown } from "@/components/shell/Markdown";
import { SmartLink } from "@/components/shell/SmartLink";
import { shellSettings } from "@/lib/server/home";

// Ways to take part that every page should offer, whatever the editable
// footer links say.
const TAKE_PART = [
  { href: "/tracker", label: "Promise tracker" },
  { href: "/volunteer", label: "Volunteer" },
  { href: "/act", label: "Petitions" },
  { href: "/me", label: "Supporter sign-in" },
  { href: "/preferences", label: "Email preferences" },
];

export async function Footer() {
  const { org, footer, socials } = await shellSettings();
  const editable = new Set(footer.links.map((l) => l.href));
  const takePart = TAKE_PART.filter((l) => !editable.has(l.href));

  return (
    <footer className="site-footer">
      <div className="container stack" style={{ gap: 40 }}>
        <div className="footer-top">
          <div className="footer-brand">
            <Image src="/images/logo-light.png" alt={org.name} width={202} height={96} style={{ height: 96, width: "auto" }} />
            {org.address && <p className="footer-address">{org.address}</p>}
            <a href={`mailto:${org.email}`} className="text-link" style={{ fontSize: 15, fontWeight: 400 }}>
              {org.email}
            </a>
            {org.phone && (
              <a href={`tel:${org.phone.replace(/[^\d+]/g, "")}`} className="footer-phone">
                {org.phone}
              </a>
            )}
          </div>
          {socials.accounts.length > 0 && (
            <div style={{ flex: "0 1 220px" }}>
              <h2 className="footer-heading">Follow</h2>
              <ul className="socials" role="list">
                {socials.accounts.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} className="social" aria-label={`${org.shortName} on ${s.name}`} title={s.name}>
                      {s.short}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {footer.links.length > 0 && (
            <div className="footer-links">
              <h2 className="footer-heading" style={{ marginBottom: 10 }}>
                Links
              </h2>
              {footer.links.map((l) => (
                <SmartLink key={l.href + l.label} href={l.href}>
                  {l.label}
                </SmartLink>
              ))}
              {org.platformUrl && <SmartLink href={org.platformUrl}>Read the platform</SmartLink>}
            </div>
          )}
          {takePart.length > 0 && (
            <div className="footer-links">
              <h2 className="footer-heading" style={{ marginBottom: 10 }}>
                Take part
              </h2>
              {takePart.map((l) => (
                <Link key={l.href} href={l.href}>
                  {l.label}
                </Link>
              ))}
            </div>
          )}
        </div>
        <Markdown text={footer.acknowledgement} className="footer-acknowledgement" />
        <div className="footer-bottom">
          <p style={{ margin: 0 }}>
            © {new Date().getFullYear()} {org.name}
            {org.authorizationLine && <span className="footer-authorization">{org.authorizationLine}</span>}
          </p>
          <p className="footer-legal">
            <SmartLink href={org.privacyUrl || "/privacy"}>Privacy</SmartLink>
            <Link href="/accessibility">Accessibility</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
