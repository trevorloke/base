import Link from "next/link";
import { Sparkline } from "@/components/admin/people/Sparkline";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { can, PERMISSIONS, requireAdmin, type Permission } from "@/lib/server/admin-auth";
import { dashboardTotals, needsAttention, VISIT_DAYS, visitStats, weeklyTrend, type VisitStats } from "@/lib/server/admin-data";
import { limitsAttention } from "@/lib/server/limits-admin";
import { ownersAttention } from "@/lib/server/staff";
import { formatDay } from "@/lib/shifts";
import "./people/people.css";
import "./visits.css";

const QUICK_LINKS: { href: string; label: string; permission?: Permission }[] = [
  { href: "/admin/people", label: "Supporters", permission: "people" },
  { href: "/admin/people/sources", label: "Where sign-ups come from", permission: "people" },
  { href: "/admin/exports", label: "Exports" },
  { href: "/admin/users", label: "Staff accounts", permission: "users" },
  { href: "/admin/audit", label: "Audit log", permission: "users" },
  { href: "/admin/account", label: "My account" },
];

export default async function AdminHome({ searchParams }: PageProps<"/admin">) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const denied = PERMISSIONS.find((p) => p.id === sp.denied);
  const db = getDb();
  const [totals, trend, attention, visits, limitNote, ownerNote] = await Promise.all([
    dashboardTotals(db),
    weeklyTrend(db),
    needsAttention(db),
    visitStats(db),
    limitsAttention(db),
    ownersAttention(db),
  ]);
  const money = (cents: number) => formatCents(cents);

  const tiles: { value: string; label: string; href?: string }[] = [
    { value: String(totals.active_members), label: "Active members", href: "/admin/people?membership=active" },
    { value: String(totals.monthly_donors), label: "Monthly donors" },
    { value: money(totals.raised_this_year_cents), label: "Raised this year" },
    { value: String(totals.subscribers), label: "Newsletter subscribers", href: "/admin/people?newsletter=subscribed" },
    { value: String(totals.signatures), label: "Signatures" },
    { value: String(totals.volunteers_this_week), label: "Volunteers this week", href: "/admin/shifts" },
    { value: String(totals.orders_to_fulfil), label: "Orders to ship", href: "/admin/exports?view=orders" },
  ];

  const items: { n: number; text: string; href: string; link: string; level: "ok" | "warn" | "bad"; permission?: Permission }[] = [
    { n: attention.failedEmailsToday, text: "emails failed to send today", href: "/admin/comms", link: "Open email & texts", level: "bad", permission: "comms" },
    { n: attention.ordersToFulfil, text: "paid orders waiting to ship", href: "/admin/exports?view=orders", link: "See orders", level: "warn", permission: "money" },
    { n: attention.stalePendingMemberships, text: "memberships pending payment for over an hour", href: "/admin/people?membership=pending", link: "See who", level: "warn", permission: "people" },
    { n: attention.overduePromises, text: "promises past their target date", href: "/admin/tracker", link: "Score them", level: "warn", permission: "tracker" },
    { n: attention.deskGiftsToLog, text: "online gifts to log at the desk", href: "/admin/desk-gifts", link: "Log them", level: "warn", permission: "money" },
    { n: attention.starbaseFailed, text: "sign-ups Starbase refused", href: "/admin/integrations/starbase?status=failed", link: "See why", level: "bad", permission: "integrations" },
  ];
  const open = items.filter((i) => i.n > 0);
  // One-off reminders with no count: next year's contribution limit, and a second owner.
  const notes: { text: string; href: string; link: string; permission: Permission }[] = [];
  if (limitNote) notes.push({ ...limitNote, link: "Contribution limits", permission: "money" });
  if (ownerNote) notes.push({ ...ownerNote, link: "Open Staff", permission: "users" });

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Dashboard</h1>
        <p className="small">Signed in as {user.name}. Numbers are for Pacific time; money is net of refunds.</p>
      </div>

      {denied && (
        <div role="alert" className="alert" style={{ marginBottom: 20 }}>
          <span aria-hidden="true" className="alert-icon">
            !
          </span>
          <span>
            Your role can&apos;t open that section ({denied.label.toLowerCase()}). Ask an owner if you need access.
          </span>
        </div>
      )}

      <div className="quick-links">
        {QUICK_LINKS.filter((l) => !l.permission || can(user, l.permission)).map((l) => (
          <Link key={l.href} href={l.href} className="btn btn--outline btn--compact">
            {l.label}
          </Link>
        ))}
      </div>

      <div className="stats">
        {tiles.map((t) => (
          <div className="stat" key={t.label}>
            <div className="value">{t.value}</div>
            <div className="label">{t.href && (!t.href.startsWith("/admin/people") || can(user, "people")) ? <Link href={t.href}>{t.label}</Link> : t.label}</div>
          </div>
        ))}
      </div>

      <div className="trends">
        <Sparkline id="trend-supporters" label="New supporters" unit="People" points={trend.map((p) => ({ label: p.weekStart, value: p.newSupporters }))} />
        <Sparkline id="trend-raised" label="Contributions" unit="Raised" points={trend.map((p) => ({ label: p.weekStart, value: p.raisedCents }))} format={money} />
      </div>

      <WebsiteVisits visits={visits} />

      <section aria-labelledby="attention-title" style={{ marginBottom: 32 }}>
        <h2 id="attention-title" className="h3" style={{ fontSize: 22, marginBottom: 12 }}>
          Needs attention
        </h2>
        {open.length === 0 && notes.length === 0 ? (
          <p className="empty-state">Nothing is waiting on you right now.</p>
        ) : (
          <ul className="attention">
            {open.map((i) => (
              <li key={i.text} data-level={i.level}>
                <span className="attention__n">{i.n}</span>
                <span className="attention__text">
                  {i.text}
                  {(!i.permission || can(user, i.permission)) && (
                    <>
                      {" "}
                      <Link href={i.href}>{i.link}</Link>
                    </>
                  )}
                </span>
              </li>
            ))}
            {notes.map((i) => (
              <li key={i.text} data-level="warn">
                <span className="attention__n" aria-hidden="true">
                  !
                </span>
                <span className="attention__text">
                  {i.text}
                  {can(user, i.permission) && (
                    <>
                      {" "}
                      <Link href={i.href}>{i.link}</Link>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const count = (n: number) => n.toLocaleString("en-CA");

function rate(signups: number, visitors: number): string {
  if (visitors === 0) return "–";
  const pct = (signups / visitors) * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function change(now: number, before: number): string {
  if (before === 0) return now === 0 ? "no change" : "new this week";
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "no change" : `${pct > 0 ? "+" : ""}${pct}% on last week`;
}

/**
 * The first-party visit counter's four tiles. Admin only: the public site
 * shows no numbers. A visitor is counted once a day (the hash's salt changes
 * every day), so "visitors" over a week or a month are visitor-days.
 */
function WebsiteVisits({ visits }: { visits: VisitStats }) {
  const { weekday, date } = formatDay(visits.weekStart);
  return (
    <section aria-labelledby="visits-title" className="visits">
      <div className="visits__head">
        <h2 id="visits-title" className="h3" style={{ fontSize: 22, margin: 0 }}>
          Website visits
        </h2>
        <p className="small" style={{ margin: 0 }}>
          Counted by the site itself, with no cookie and no IP address stored. A visitor counts once a day.
        </p>
      </div>
      <div className="visits__grid">
        <figure className="visit-tile" data-tile="week">
          <figcaption className="trend__label">Visits this week</figcaption>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Visitors and page views this week (from {weekday}, {date}) and last week</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Measure</span>
                  </th>
                  <th scope="col">This week</th>
                  <th scope="col">Last week</th>
                </tr>
              </thead>
              <tbody>
                <tr data-row="visitors">
                  <th scope="row">Visitors</th>
                  <td data-col="this">{count(visits.thisWeek.visitors)}</td>
                  <td data-col="last">{count(visits.lastWeek.visitors)}</td>
                </tr>
                <tr data-row="views">
                  <th scope="row">Page views</th>
                  <td data-col="this">{count(visits.thisWeek.views)}</td>
                  <td data-col="last">{count(visits.lastWeek.views)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="trend__delta visit-tile__note">
            Since {weekday}, {date}: visitors {change(visits.thisWeek.visitors, visits.lastWeek.visitors)}.
          </p>
        </figure>

        <figure className="visit-tile" data-tile="sources">
          <figcaption className="trend__label">Sign-up rate by source, last {VISIT_DAYS} days</figcaption>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Visitors and new supporters by source over the last {VISIT_DAYS} days</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Visitors</th>
                  <th scope="col">Sign-ups</th>
                  <th scope="col">Rate</th>
                </tr>
              </thead>
              <tbody>
                {visits.bySource.map((s) => (
                  <tr key={s.source} data-source={s.source}>
                    <th scope="row">{s.source}</th>
                    <td data-col="visitors">{count(s.visitors)}</td>
                    <td data-col="signups">{count(s.signups)}</td>
                    <td data-col="rate">{rate(s.signups, s.visitors)}</td>
                  </tr>
                ))}
                <tr data-source="(all)">
                  <th scope="row">All visits</th>
                  <td data-col="visitors">{count(visits.all30.visitors)}</td>
                  <td data-col="signups">{count(visits.all30.signups)}</td>
                  <td data-col="rate">{rate(visits.all30.signups, visits.all30.visitors)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="trend__delta visit-tile__note">
            A source is the <code>?source=</code> tag on a shared link. Sign-ups are new supporter records with that source.
          </p>
        </figure>

        <figure className="visit-tile" data-tile="pages">
          <figcaption className="trend__label">Top pages, last {VISIT_DAYS} days</figcaption>
          {visits.topPages.length === 0 ? (
            <p className="empty-state">No page views yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">The most viewed pages over the last {VISIT_DAYS} days</caption>
                <thead>
                  <tr>
                    <th scope="col">Page</th>
                    <th scope="col">Views</th>
                    <th scope="col">Visitors</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.topPages.map((p) => (
                    <tr key={p.path} data-path={p.path}>
                      <th scope="row" className="cell-wrap">
                        {p.path}
                      </th>
                      <td data-col="views">{count(p.views)}</td>
                      <td data-col="visitors">{count(p.visitors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </figure>

        <figure className="visit-tile" data-tile="referrers">
          <figcaption className="trend__label">Where visitors come from, last {VISIT_DAYS} days</figcaption>
          {visits.referrers.length === 0 ? (
            <p className="empty-state">No visits from other sites yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Sites that sent visitors over the last {VISIT_DAYS} days</caption>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Visitors</th>
                    <th scope="col">Views</th>
                  </tr>
                </thead>
                <tbody>
                  {visits.referrers.map((r) => (
                    <tr key={r.host} data-host={r.host}>
                      <th scope="row">{r.host}</th>
                      <td data-col="visitors">{count(r.visitors)}</td>
                      <td data-col="views">{count(r.views)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="trend__delta visit-tile__note">Visits typed in, from a bookmark or from an app that hides where it came from aren&apos;t listed.</p>
        </figure>
      </div>
    </section>
  );
}
