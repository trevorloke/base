import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage, SavedNotice } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS, publishStatus } from "@/components/admin/content/fields";
import { NewsForm } from "@/components/admin/content/NewsForm";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { loadNews } from "@/lib/server/content-admin";
import { deleteNews, setNewsPublished } from "../actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EditNews({ params, searchParams }: PageProps<"/admin/content/news/[id]">) {
  await requireAdmin("content");
  const { id } = await params;
  const sp = await searchParams;
  const post = UUID.test(id) ? await loadNews(getDb(), id) : undefined;
  if (!post) notFound();
  const status = publishStatus(post.publishedAt);
  return (
    <AdminPage
      title={post.title}
      eyebrow="Edit post"
      crumbs={[{ href: "/admin/content", label: "Content" }, { href: ADMIN_PATHS.news, label: "News" }]}
      actions={
        status === "published" ? (
          <Link href={`/news/${post.slug}`} className="btn btn--outline" target="_blank" rel="noreferrer">
            View on the site ↗
          </Link>
        ) : null
      }
    >
      <SavedNotice saved={sp.saved} />
      <NewsForm post={{ id: post.id, title: post.title, slug: post.slug, summary: post.summary, body: post.body, imageUrl: post.imageUrl, imageAlt: post.imageAlt, publishedAt: post.publishedAt?.toISOString() ?? null }} />
      <div className="cms-danger">
        <p>{status === "published" ? "Unpublishing turns the post back into a draft; deleting removes it for good." : "Deleting removes the post for good."}</p>
        {status === "published" && (
          <ActionForm action={setNewsPublished} fields={{ id: post.id, publish: "0" }} buttonClassName="btn btn--outline" confirm="Unpublish this post? It will disappear from the site until you publish it again.">
            Unpublish
          </ActionForm>
        )}
        <ActionForm action={deleteNews} fields={{ id: post.id }} buttonClassName="btn btn--danger" confirm="Delete this post for good? This can't be undone." pendingText="Deleting…">
          Delete post
        </ActionForm>
      </div>
    </AdminPage>
  );
}
