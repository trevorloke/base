import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { formatDate } from "@/lib/dates";
import { renderMarkdown } from "@/lib/markdown";
import { pageBySlug } from "@/lib/server/content";
import "./page.css";

// Free-form pages written in /admin/pages, such as the privacy policy.
export const revalidate = 3600;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function generateMetadata({ params }: PageProps<"/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return {};
  const page = await pageBySlug(slug);
  if (!page) return {};
  return { title: page.title, description: page.summary || undefined, openGraph: { title: page.title, description: page.summary || undefined, type: "article" } };
}

export default async function SitePage({ params }: PageProps<"/[slug]">) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) notFound();
  const page = await pageBySlug(slug);
  if (!page) notFound();
  return (
    <>
      <PageHead title={page.title}>{page.summary || undefined}</PageHead>
      <section className="section">
        <div className="container stack" style={{ gap: 24 }}>
          <div className="prose site-page" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.body) }} />
          <p className="site-page-updated">Last updated {formatDate(page.updatedAt)}.</p>
        </div>
      </section>
    </>
  );
}
