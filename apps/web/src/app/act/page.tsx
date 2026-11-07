import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { excerpt } from "@/lib/markdown";
import { listActiveCampaigns } from "@/lib/server/campaigns";
import "./act.css";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Take action",
  description: "Petitions and pledges from Imagine Surrey: add your name and help hold City Hall to account.",
};

export default async function ActIndex() {
  const campaigns = await listActiveCampaigns();
  return (
    <>
      <PageHead title="Take action">Add your name to a petition or a pledge. Every signature is a Surrey resident City Hall has to answer to.</PageHead>
      <section className="section section--surface">
        <div className="container stack" style={{ gap: 24 }}>
          {campaigns.length === 0 ? (
            <p className="empty-state">No campaigns are open right now. Get the newsletter to hear about the next one.</p>
          ) : (
            <div className="act-grid">
              {campaigns.map((c) => (
                <article key={c.slug} className="card card--white act-card">
                  <p className="eyebrow">{c.kind === "pledge" ? "Pledge" : "Petition"}</p>
                  <h2 className="h3">
                    <Link href={`/act/${c.slug}`}>{c.title}</Link>
                  </h2>
                  <p>{excerpt(c.body || c.statement, 180)}</p>
                  <Link href={`/act/${c.slug}`} className="btn btn--accent">
                    {c.kind === "pledge" ? "Sign the pledge" : "Add my name"}
                    <span className="visually-hidden">: {c.title}</span>
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
