import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { EmbedPreview } from "@/components/tracker/EmbedPreview";
import { embedCopy } from "@/content/tracker";
import { env } from "@/lib/env";
import "../tracker.css";

export const metadata: Metadata = {
  title: embedCopy.title,
  description: embedCopy.lede,
  alternates: { canonical: "/tracker/embed" },
};

export default function EmbedPage() {
  const site = env.siteUrl;
  const snippet = `<div id="imagine-surrey-tracker"></div>\n<script src="${site}/embed/tracker.js" data-target="imagine-surrey-tracker" data-site="${site}" defer></script>`;
  return (
    <>
      <PageHead title={embedCopy.title} eyebrow="Promise tracker · embed">
        {embedCopy.lede}
      </PageHead>
      <section className="section">
        <div className="container split" style={{ alignItems: "flex-start" }}>
          <div className="stack" style={{ flex: "1 1 420px", gap: 20 }}>
            <EmbedPreview snippet={snippet} />
          </div>
          <div className="stack" style={{ flex: "1 1 380px", gap: 16 }}>
            <h2 className="h3" style={{ fontSize: 22 }}>
              How it works
            </h2>
            <p className="body">{embedCopy.howTo}</p>
            <ol className="embed-steps">
              <li>Paste the snippet into your page where the card should appear.</li>
              <li>
                The script reads <code>{site}/api/promises/summary</code>, a public JSON endpoint that allows requests from any site.
              </li>
              <li>It draws the card with its own inline styles, so your stylesheet is left alone. Resize the container to fit your layout.</li>
              <li>Prefer to build your own? Use the JSON API directly and link back to the tracker.</li>
            </ol>
            <ul className="tracker-toolbar" aria-label="Related">
              <li>
                <a href="/api/promises/summary">Summary JSON</a>
              </li>
              <li>
                <a href="/api/promises">Every promise as JSON</a>
              </li>
              <li>
                <Link href="/tracker/methodology">How the promises are scored</Link>
              </li>
              <li>
                <Link href="/tracker">Back to the tracker</Link>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
