import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/admin/content/ActionForm";
import { AdminPage, SavedNotice } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { ProductForm } from "@/components/admin/content/ProductForm";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { loadProduct } from "@/lib/server/content-admin";
import { deleteProduct } from "../actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EditProduct({ params, searchParams }: PageProps<"/admin/content/products/[id]">) {
  await requireAdmin("content");
  const { id } = await params;
  const sp = await searchParams;
  const data = UUID.test(id) ? await loadProduct(getDb(), id) : undefined;
  if (!data) notFound();
  const { product, orders } = data;
  return (
    <AdminPage
      title={product.name}
      eyebrow="Edit product"
      crumbs={[{ href: "/admin/content", label: "Content" }, { href: ADMIN_PATHS.products, label: "Shop" }]}
      actions={
        <Link href="/shop" className="btn btn--outline" target="_blank" rel="noreferrer">
          View the shop ↗
        </Link>
      }
    >
      <SavedNotice saved={sp.saved} />
      <ProductForm product={{ ...product }} />
      <div className="cms-danger">
        {orders > 0 ? (
          <p>This product is on {orders} past order{orders === 1 ? "" : "s"}, so it can&apos;t be deleted. Untick &ldquo;For sale&rdquo; above to take it off the shop.</p>
        ) : (
          <>
            <p>No orders include this product yet, so it can be deleted for good.</p>
            <ActionForm action={deleteProduct} fields={{ id: product.id }} buttonClassName="btn btn--danger" confirm="Delete this product for good? This can't be undone." pendingText="Deleting…">
              Delete product
            </ActionForm>
          </>
        )}
      </div>
    </AdminPage>
  );
}
