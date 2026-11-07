import { notFound } from "next/navigation";
import "../volunteer/volunteer.css";
import "./neighbourhoods.css";
import type { Metadata } from "next";
import Link from "next/link";
import { PostalLookup } from "@/components/neighbourhoods/PostalLookup";
import { PageHead } from "@/components/PageHead";
import { HAS_NEIGHBOURHOODS, NEIGHBOURHOOD_FSAS, NEIGHBOURHOOD_SLUGS, neighbourhoodFromSlug } from "@/lib/neighbourhoods";
import { getSettings } from "@/lib/server/settings";
import { clientProfile } from "@/seeds/client";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Neighbourhoods",
  description: `Find your ${clientProfile.place ? `${clientProfile.place} ` : ""}neighbourhood: what's happening near you, how to volunteer there, and the promises that affect it.`,
};

export default async function NeighbourhoodsIndex() {
  // A client without neighbourhoods has no neighbourhood pages.
  if (!HAS_NEIGHBOURHOODS) notFound();
  const { committees } = await getSettings();
  return (
    <>
      <PageHead title={committees.neighbourhoodsTitle} eyebrow="Where you live">
        {committees.neighbourhoodsIntro}
      </PageHead>
      <section className="section section--surface">
        <div className="container stack" style={{ gap: 36 }}>
          <PostalLookup />
          <div className="stack" style={{ gap: 16 }}>
            <h2 className="h3" style={{ margin: 0 }}>
              Or pick a town centre
            </h2>
            <ul className="hood-grid">
              {NEIGHBOURHOOD_SLUGS.map((slug) => {
                const name = neighbourhoodFromSlug(slug)!;
                return (
                  <li key={slug}>
                    <Link href={`/neighbourhoods/${slug}`} className="tile hood-tile">
                      <span className="hood-name">{name}</span>
                      <span className="small">Postal codes {NEIGHBOURHOOD_FSAS[name].join(", ")}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
