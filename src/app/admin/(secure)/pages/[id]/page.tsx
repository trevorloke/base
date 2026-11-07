import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage, SavedNotice } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { PageForm } from "@/components/admin/content/PageForm";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { loadPage } from "@/lib/server/content-admin";
import { deletePage } from "../actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EditPage({ params, searchParams }: PageProps<"/admin/pages/[id]">) {
  await requireAdmin("content");
  const { id } = await params;
  const sp = await searchParams;
  const page = UUID.test(id) ? await loadPage(getDb(), id) : undefined;
  if (!page) notFound();
  return (
    <AdminPage
      title={page.title}
      eyebrow="Edit page"
      crumbs={[{ href: "/admin/content", label: "Content" }, { href: ADMIN_PATHS.pages, label: "Pages" }]}
      actions={
        page.published ? (
          <Link href={`/${page.slug}`} className="btn btn--outline" target="_blank" rel="noreferrer">
            View on the site ↗
          </Link>
        ) : null
      }
    >
      <SavedNotice saved={sp.saved} />
      <PageForm page={{ id: page.id, slug: page.slug, title: page.title, summary: page.summary, body: page.body, published: page.published, showInFooter: page.showInFooter }} />
      <div className="cms-danger">
        <p>Deleting removes the page for good. To take it off the site without losing the text, untick &ldquo;Published&rdquo; instead.</p>
        <ActionForm action={deletePage} fields={{ id: page.id }} buttonClassName="btn btn--danger" confirm="Delete this page for good? This can't be undone." pendingText="Deleting…">
          Delete page
        </ActionForm>
      </div>
    </AdminPage>
  );
}
