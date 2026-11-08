import type { Metadata } from "next";
import { Cart } from "@/components/Cart";
import { PageHead } from "@/components/PageHead";
import { activeProducts } from "@/lib/server/content";
import { clientProfile } from "@/seeds/client";

export const metadata: Metadata = { title: "Shop", description: `Lawn signs, shirts, buttons and more from ${clientProfile.orgName}.` };

export default async function ShopPage() {
  const products = await activeProducts();
  return (
    <>
      <PageHead title="Get the merch">Lawn signs, shirts, and buttons. Choose what you’d like and check out securely with Stripe. We ship across Canada.</PageHead>
      <section className="section section--surface">
        <div className="container stack" style={{ gap: 24 }}>
          {products.length === 0 ? (
            <p className="empty-state">The shop is restocking. Check back soon.</p>
          ) : (
            <Cart
              products={products.map(({ slug, name, description, priceCents, tileLabel, tileBackground, tileForeground }) => ({
                slug,
                name,
                description,
                priceCents,
                tileLabel,
                tileBackground,
                tileForeground,
              }))}
            />
          )}
        </div>
      </section>
    </>
  );
}
