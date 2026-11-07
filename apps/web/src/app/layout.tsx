import { TrackingCapture } from "@/components/engage/TrackingCapture";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { AnnouncementBar } from "@/components/shell/AnnouncementBar";
import { StickyActions } from "@/components/shell/StickyActions";
import { VisitBeacon } from "@/components/VisitBeacon";
import { env } from "@/lib/env";
import { shellSettings } from "@/lib/server/home";
import { renderAtRequestTimeWithoutDatabase } from "@/lib/server/render-time";
import "./globals.css";
import "@/components/shell/shell.css";

// Montserrat variable font (latin), self-hosted. SIL Open Font License.
const montserrat = localFont({
  src: "../fonts/montserrat-latin.woff2",
  weight: "400 900",
  display: "swap",
  variable: "--font-montserrat",
});

export async function generateMetadata(): Promise<Metadata> {
  await renderAtRequestTimeWithoutDatabase();
  const { seo, org } = await shellSettings();
  return {
    metadataBase: new URL(env.siteUrl),
    title: { default: seo.title, template: `%s · ${seo.title}` },
    description: seo.description,
    applicationName: org.name,
    openGraph: { type: "website", siteName: org.name, locale: "en_CA", title: seo.title, description: seo.description },
    twitter: { card: "summary_large_image" },
    icons: { icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }, { url: "/images/logo.webp" }] },
  };
}

export const viewport: Viewport = { themeColor: "#003979" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await renderAtRequestTimeWithoutDatabase();
  const { org, socials, announcement, seo, header } = await shellSettings();
  const siteUrl = env.siteUrl;
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    url: siteUrl,
    description: seo.description,
    email: org.email,
    ...(org.phone ? { telephone: org.phone } : {}),
    ...(org.address ? { address: org.address } : {}),
    sameAs: [...socials.accounts.map((s) => s.url), ...socials.also.map((s) => s.url)].filter((u, i, all) => /^https?:\/\//.test(u) && all.indexOf(u) === i),
  };
  const plausible = env.plausibleDomain;
  const ga = env.gaMeasurementId;
  const showAnnouncement = announcement.enabled && announcement.text.trim() !== "";

  return (
    <html lang="en" className={montserrat.variable}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {/* Remembers ?ref= and ?source= for 30 days so later sign-ups are credited. */}
        <TrackingCapture />
        {/* Counts page views for the admin dashboard: first-party, no cookie, no IP stored. */}
        <VisitBeacon />
        {showAnnouncement && <AnnouncementBar text={announcement.text} linkLabel={announcement.linkLabel} linkHref={announcement.linkHref} />}
        <Header links={header.links} cta={{ label: header.ctaLabel, href: header.ctaHref }} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <Footer />
        <StickyActions />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization).replace(/</g, "\\u003c") }} />
        {plausible && <Script defer data-domain={plausible} src="https://plausible.io/js/script.js" strategy="afterInteractive" />}
        {ga && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga)}`} strategy="afterInteractive" />
            <Script id="gtag-init" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',${JSON.stringify(ga)},{anonymize_ip:true});`}
            </Script>
          </>
        )}
      </body>
    </html>
  );
}
