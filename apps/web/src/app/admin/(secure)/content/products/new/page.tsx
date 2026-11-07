import { AdminPage } from "@/components/admin/content/AdminPage";
import { ProductForm } from "@/components/admin/content/ProductForm";
import { requireAdmin } from "@/lib/server/admin-auth";

export default async function NewProduct() {
  await requireAdmin("content");
  return (
    <AdminPage title="Add a product" crumbs={[{ href: "/admin/content", label: "Content" }, { href: "/admin/content/products", label: "Shop" }]}>
      <ProductForm />
    </AdminPage>
  );
}
