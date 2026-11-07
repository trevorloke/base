import { TrackingCapture } from "@/components/engage/TrackingCapture";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { AnnouncementBar } from "@/components/shell/AnnouncementBar";
import { StickyActions } from "@/components/shell/StickyActions";
import { VisitBeacon } from "@/components/VisitBeacon";
import { brandCss, brandName } from "@/lib/brand";
import { env } from "@/lib/env";
import { shellBrand } from "@/lib/server/brand";
import { shellSettings } from "@/lib/server/home";
import { renderAtRequestTimeWithoutDatabase } from "@/lib/server/render-time";
import { fontVariables } from "./fonts";
import "./globals.css";
import "@/components/shell/shell.css";

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

export async function generateViewport(): Promise<Viewport> {
  await renderAtRequestTimeWithoutDatabase();
  return { themeColor: (await shellBrand()).colors.primary };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await renderAtRequestTimeWithoutDatabase();
  const [{ org, socials, announcement, seo, header }, brand] = await Promise.all([shellSettings(), shellBrand()]);
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
    <html lang="en" className={fontVariables}>
      <head>
        {/* The brand (Admin → Brand) as CSS custom properties, in the HTML itself so there is no flash of another look. */}
        <style id="brand-tokens" dangerouslySetInnerHTML={{ __html: brandCss(brand) }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {/* Remembers ?ref= and ?source= for 30 days so later sign-ups are credited. */}
        <TrackingCapture />
        {/* Counts page views for the admin dashboard: first-party, no cookie, no IP stored. */}
        <VisitBeacon />
        {showAnnouncement && <AnnouncementBar text={announcement.text} linkLabel={announcement.linkLabel} linkHref={announcement.linkHref} />}
        <Header links={header.links} cta={{ label: header.ctaLabel, href: header.ctaHref }} brand={{ name: brandName(brand, org.name), logoUrl: brand.logoUrl }} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <Footer brand={brand} />
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
