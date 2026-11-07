import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { SiteImage } from "@/components/shell/SiteImage";
import { formatDate } from "@/lib/dates";
import { latestNews } from "@/lib/server/content";
import { shellSettings } from "@/lib/server/home";

export async function generateMetadata(): Promise<Metadata> {
  const { org } = await shellSettings();
  const description = `News releases and updates from ${org.name}.`;
  return { title: "News", description, alternates: { canonical: "/news" }, openGraph: { title: `News · ${org.name}`, description, url: "/news" } };
}

export default async function NewsIndex() {
  const posts = await latestNews(100);
  return (
    <>
      <PageHead title="News">Releases and updates from Imagine Surrey.</PageHead>
      <section className="section">
        <div className="container">
          {posts.length === 0 ? (
            <p className="empty-state">
              No news yet. <Link href="/#newsletter">Sign up for the newsletter</Link> to hear first.
            </p>
          ) : (
            <div className="card-grid">
              {posts.map((post) => (
                <article key={post.id} className="card news-card">
                  {post.imageUrl && (
                    <SiteImage src={post.imageUrl} alt={post.imageAlt ?? ""} width={1200} height={675} sizes="(max-width: 760px) 100vw, 360px" className="news-card-image" />
                  )}
                  <p className="eyebrow">
                    <time dateTime={post.publishedAt!.toISOString()}>{formatDate(post.publishedAt!)}</time>
                  </p>
                  <h2 className="h3">{post.title}</h2>
                  <p>{post.summary}</p>
                  <Link href={`/news/${post.slug}`} className="text-link" style={{ fontSize: 15 }}>
                    Read more<span className="visually-hidden">: {post.title}</span>
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
