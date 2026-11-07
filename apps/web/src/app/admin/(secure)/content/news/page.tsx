import Link from "next/link";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS, publishStatus } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listNews } from "@/lib/server/content-admin";
import { setNewsPublished } from "./actions";

const LABEL = { draft: "Draft", scheduled: "Scheduled", published: "Published" } as const;

export default async function NewsAdmin({ searchParams }: PageProps<"/admin/content/news">) {
  await requireAdmin("content");
  const sp = await searchParams;
  const posts = await listNews(getDb());
  return (
    <AdminPage
      title="News"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro="Posts appear on /news and the home page once published. Scheduled posts go live on their own at the chosen time."
      actions={
        <Link href={`${ADMIN_PATHS.news}/new`} className="btn btn--red">
          Write a post
        </Link>
      }
    >
      {sp.deleted && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>The post was deleted.</span>
        </div>
      )}
      {posts.length === 0 ? (
        <p className="empty-state">No posts yet. Write the first one.</p>
      ) : (
        <div className="table-wrap">
          <table className="table cms-table">
            <thead>
              <tr>
                <th scope="col">Headline</th>
                <th scope="col">Status</th>
                <th scope="col">Date</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => {
                const status = publishStatus(p.publishedAt);
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={`${ADMIN_PATHS.news}/${p.id}`}>
                        <strong>{p.title}</strong>
                      </Link>
                      <br />
                      <span className="small">/news/{p.slug}</span>
                    </td>
                    <td className="nowrap">
                      <Badge tone={status === "published" ? "live" : status}>{LABEL[status]}</Badge>
                    </td>
                    <td className="nowrap">{p.publishedAt ? formatDate(p.publishedAt) : formatDate(p.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        {status === "published" && (
                          <Link href={`/news/${p.slug}`} className="btn btn--outline btn--sm" target="_blank" rel="noreferrer">
                            View<span className="visually-hidden"> {p.title} on the site</span>
                          </Link>
                        )}
                        <ActionForm action={setNewsPublished} fields={{ id: p.id, publish: status === "published" ? "0" : "1" }} buttonClassName="btn btn--outline btn--sm" buttonProps={{ "aria-label": `${status === "published" ? "Unpublish" : "Publish"} ${p.title}` }}>
                          {status === "published" ? "Unpublish" : "Publish now"}
                        </ActionForm>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
