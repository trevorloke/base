import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { shellSettings } from "@/lib/server/home";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Accessibility",
  description: "How we make the Imagine Surrey website work for everyone, what still needs fixing, and how to tell us about a problem.",
  alternates: { canonical: "/accessibility" },
};

// Update this whenever the statement changes.
const REVIEWED = "November 2, 2026";

export default async function AccessibilityPage() {
  const { org } = await shellSettings();
  return (
    <>
      <PageHead title="Accessibility" eyebrow="Accessibility statement">
        Everyone in Surrey should be able to read this site, sign a petition, join, give and volunteer, whatever device or assistive technology they use.
      </PageHead>
      <section className="section">
        <div className="container stack prose statement" style={{ gap: 8 }}>
          <h2 className="h3">Our target</h2>
          <p>
            We aim to meet the <a href="https://www.w3.org/TR/WCAG22/">Web Content Accessibility Guidelines (WCAG) 2.2</a> at level AA across the public site and
            the tools our volunteers and staff use.
          </p>

          <h2 className="h3">What works</h2>
          <ul>
            <li>
              <strong>Keyboard.</strong> Every link, button and form can be reached and used with a keyboard. The menu opens with Enter or Space and closes with
              Escape, returning you to the menu button. Drag-and-drop in our volunteer tools always has a tap or keyboard alternative.
            </li>
            <li>
              <strong>Skip link.</strong> The first thing you reach with Tab is &ldquo;Skip to content&rdquo;, which jumps past the navigation to the main
              content.
            </li>
            <li>
              <strong>Visible focus.</strong> The element you are on always has a thick two-colour outline that shows on navy, white, grey and yellow.
            </li>
            <li>
              <strong>Reduced motion.</strong> If your device asks for reduced motion, the rotating words on the home page stay still, counters show their
              final numbers straight away and the page doesn&apos;t animate as you scroll. Anything that moves can be paused.
            </li>
            <li>
              <strong>Forms.</strong> Every field has a visible label. Errors are announced, shown next to the field they belong to, and focus moves to the first
              one.
            </li>
            <li>
              <strong>Colour and contrast.</strong> Text meets a 4.5:1 contrast ratio (3:1 for large text). Promise statuses on the tracker carry an icon and a
              word, never colour alone.
            </li>
            <li>
              <strong>Zoom and small screens.</strong> Pages are built phone first and are checked at 360 pixels wide for sideways scrolling.
            </li>
            <li>
              <strong>Captions.</strong> Videos we publish have captions, and recordings of meetings get captions or a transcript. Live streams carry live captions
              where the platform supports them.
            </li>
          </ul>

          <h2 className="h3">Known issues</h2>
          <p>We know about these and are working on them:</p>
          <ul>
            <li>
              Our 2026 platform is hosted as a document on Issuu, which doesn&apos;t work well with screen readers. Email us and we&apos;ll send it in a format
              that works for you.
            </li>
            <li>
              Payments are handled on Stripe&apos;s checkout pages, and our social media accounts live on other platforms. We choose accessible services, but we
              don&apos;t control those pages.
            </li>
            <li>The site is in English only for now. We can answer questions in other languages by email.</li>
            <li>On the narrowest phones (320 pixels wide, or 400% zoom on a laptop), parts of the promise tracker still scroll sideways.</li>
            <li>
              Images uploaded by our team rely on the description written at upload time. If you find an image with a missing or unhelpful description, please
              tell us.
            </li>
            <li>
              We check pages with keyboard-only and screen-reader walkthroughs and automated structural tests, but we have not yet had an independent audit.
            </li>
          </ul>

          <h2 className="h3">Tell us about a problem</h2>
          <p>
            If something on the site doesn&apos;t work for you, email <a href={`mailto:${org.email}?subject=${encodeURIComponent("Accessibility problem")}`}>{org.email}</a>
            {org.phone ? (
              <>
                {" "}
                or call <a href={`tel:${org.phone.replace(/[^\d+]/g, "")}`}>{org.phone}</a>
              </>
            ) : null}
            . Tell us the page and what happened, and we&apos;ll get back to you. If you were trying to join, give or sign something, we&apos;ll
            help you do it another way.
          </p>

          <p className="small" style={{ marginTop: 24 }}>
            This statement was last reviewed on {REVIEWED}. <Link href="/">Back to the home page</Link>
          </p>
        </div>
      </section>
    </>
  );
}
