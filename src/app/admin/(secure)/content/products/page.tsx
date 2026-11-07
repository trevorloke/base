import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS, centsToDollars } from "@/components/admin/content/fields";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listProducts } from "@/lib/server/content-admin";

export default async function ProductsAdmin({ searchParams }: PageProps<"/admin/content/products">) {
  await requireAdmin("content");
  const sp = await searchParams;
  const rows = await listProducts(getDb());
  return (
    <AdminPage
      title="Shop"
      crumbs={[{ href: "/admin/content", label: "Content" }]}
      intro="Products for sale on /shop. Prices are in dollars; orders are paid through Stripe Checkout."
      actions={
        <Link href={`${ADMIN_PATHS.products}/new`} className="btn btn--red">
          Add a product
        </Link>
      }
    >
      {sp.deleted && (
        <div role="status" className="alert alert--note">
          <span aria-hidden="true" className="alert-icon">
            ✓
          </span>
          <span>The product was deleted.</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="empty-state">No products yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table cms-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Price</th>
                <th scope="col">Tile</th>
                <th scope="col">Orders</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`${ADMIN_PATHS.products}/${p.id}`}>
                      <strong>{p.name}</strong>
                    </Link>
                    <br />
                    <span className="small">sort {p.sortOrder}</span>
                  </td>
                  <td className="nowrap">${centsToDollars(p.priceCents)}</td>
                  <td>
                    {p.imageUrl ? (
                      "Photo"
                    ) : (
                      <span className="tile-preview" style={{ background: p.tileBackground, color: p.tileForeground, width: 120, height: 56, fontSize: 13 }} aria-hidden="true">
                        {p.tileLabel}
                      </span>
                    )}
                  </td>
                  <td>{p.orders}</td>
                  <td className="nowrap">{p.active ? <Badge tone="live">For sale</Badge> : <Badge tone="off">Hidden</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
