import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/PageHead";
import { Markdown } from "@/components/shell/Markdown";
import { ShareRow } from "@/components/shell/ShareRow";
import { SiteImage } from "@/components/shell/SiteImage";
import { formatDate } from "@/lib/dates";
import { env } from "@/lib/env";
import { newsBySlug } from "@/lib/server/content";

export async function generateMetadata({ params }: PageProps<"/news/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const post = await newsBySlug(slug);
  if (!post) return { title: "News" };
  const url = `/news/${post.slug}`;
  return {
    title: post.title,
    description: post.summary,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.summary,
      url,
      publishedTime: post.publishedAt?.toISOString(),
      modifiedTime: post.updatedAt.toISOString(),
      ...(post.imageUrl ? { images: [{ url: post.imageUrl, alt: post.imageAlt ?? "" }] } : {}),
    },
  };
}

export default async function NewsPost({ params }: PageProps<"/news/[slug]">) {
  const post = await newsBySlug((await params).slug);
  if (!post) notFound();
  return (
    <>
      <PageHead title={post.title} eyebrow={formatDate(post.publishedAt!)}>
        {post.summary}
      </PageHead>
      <article className="section">
        <div className="container stack" style={{ gap: 28 }}>
          {post.imageUrl && (
            <SiteImage src={post.imageUrl} alt={post.imageAlt ?? ""} width={1200} height={675} sizes="(max-width: 768px) 100vw, 720px" className="news-image" />
          )}
          <Markdown text={post.body} className="prose" />
          <ShareRow url={`${env.siteUrl}/news/${post.slug}`} text={post.title} subject={post.title} />
          <Link href="/news" className="text-link">
            ← All news
          </Link>
        </div>
      </article>
    </>
  );
}
