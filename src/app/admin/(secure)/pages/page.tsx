import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listPages } from "@/lib/server/content-admin";

export default async function PagesAdmin({ searchParams }: PageProps<"/admin/pages">) {
  await requireAdmin("content");
  const sp = await searchParams;
  const rows = await listPages(getDb());
  return (
    <AdminPage
      title="Pages"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro="Free-form pages such as the privacy policy, served at /<address>. Tick 'Link to it from the footer' to list a page there."
      actions={
        <Link href={`${ADMIN_PATHS.pages}/new`} className="btn btn--red">
          Create a page
        </Link>
      }
    >
      {sp.deleted && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>The page was deleted.</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="empty-state">No pages yet. The seed script adds a privacy policy and an accessibility statement.</p>
      ) : (
        <div className="table-wrap">
          <table className="table cms-table">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Address</th>
                <th scope="col">Updated</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`${ADMIN_PATHS.pages}/${p.id}`}>
                      <strong>{p.title}</strong>
                    </Link>
                  </td>
                  <td className="nowrap">
                    {p.published ? (
                      <a href={`/${p.slug}`} target="_blank" rel="noreferrer">
                        /{p.slug}
                      </a>
                    ) : (
                      `/${p.slug}`
                    )}
                    {p.showInFooter ? <span className="small"> · in footer</span> : null}
                  </td>
                  <td className="nowrap">{formatDate(p.updatedAt)}</td>
                  <td className="nowrap">{p.published ? <Badge tone="live">Published</Badge> : <Badge tone="draft">Draft</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
