import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { ADMIN_PATHS } from "@/components/admin/content/fields";
import { getDb } from "@/lib/db";
import { formatEventTime } from "@/lib/dates";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { contentCounts, nextEvents } from "@/lib/server/content-admin";

export default async function ContentHub() {
  const user = await requireAdmin("content");
  const db = getDb();
  const [counts, upcoming] = await Promise.all([contentCounts(db), nextEvents(db)]);

  const cards: { href: string; title: string; body: string; add: { href: string; label: string } | null }[] = [
    { href: ADMIN_PATHS.news, title: "News", body: `${counts.news_published} published · ${counts.news_unpublished} draft or scheduled`, add: { href: `${ADMIN_PATHS.news}/new`, label: "Write a post" } },
    { href: ADMIN_PATHS.events, title: "Events", body: `${counts.events_upcoming} upcoming`, add: { href: `${ADMIN_PATHS.events}/new`, label: "Add an event" } },
    { href: ADMIN_PATHS.products, title: "Shop", body: `${counts.products_active} for sale`, add: { href: `${ADMIN_PATHS.products}/new`, label: "Add a product" } },
    { href: ADMIN_PATHS.campaigns, title: "Petitions and pledges", body: `${counts.campaigns_active} active`, add: { href: `${ADMIN_PATHS.campaigns}/new`, label: "Start a campaign" } },
    { href: ADMIN_PATHS.pages, title: "Pages", body: `${counts.pages_published} published · ${counts.pages_draft} draft`, add: { href: `${ADMIN_PATHS.pages}/new`, label: "Create a page" } },
    { href: ADMIN_PATHS.media, title: "Media library", body: `${counts.media} file${counts.media === 1 ? "" : "s"}`, add: null },
  ];
  if (can(user, "settings")) cards.push({ href: ADMIN_PATHS.settings, title: "Site settings", body: "Every piece of copy on the public pages.", add: null });
  if (can(user, "integrations")) cards.push({ href: ADMIN_PATHS.integrations, title: "Integrations", body: "Stripe, email, texts, storage, analytics and the cron job.", add: null });

  return (
    <AdminPage title="Content" intro="Everything visitors read: news, events, the shop, petitions and pledges, free-form pages and images. Changes show on the public site within a minute.">
      <div className="cms-cards">
        {cards.map((c) => (
          <div key={c.href} className="cms-card">
            <h2>
              <Link href={c.href}>{c.title}</Link>
            </h2>
            <p className="cms-card-meta">{c.body}</p>
            <div className="btn-row" style={{ gap: 8, marginTop: 4 }}>
              <Link href={c.href} className="btn btn--outline btn--sm">
                Open
              </Link>
              {c.add && (
                <Link href={c.add.href} className="btn btn--navy btn--sm">
                  {c.add.label}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
      {upcoming.length > 0 && (
        <section className="stack" style={{ gap: 8 }}>
          <h2 className="h3" style={{ fontSize: 20 }}>
            Next events
          </h2>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {upcoming.map((e) => (
              <li key={e.id}>
                <Link href={`${ADMIN_PATHS.events}/${e.id}`}>{e.title}</Link> · {formatEventTime(e.startsAt)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </AdminPage>
  );
}
