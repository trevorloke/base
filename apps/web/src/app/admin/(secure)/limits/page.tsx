import Link from "next/link";
import { pacificYear } from "@/lib/contributions";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { formatCents } from "@/lib/money";
import { requireAdmin } from "@/lib/server/admin-auth";
import { listLimits } from "@/lib/server/limits-admin";
import { saveLimitAction } from "./actions";
import { LimitForm } from "./LimitForm";
import "../people/people.css";

const WHEN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric" });

/** Dollars as typed in the form: "1429.70", no sign or commas. */
const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * The BC contribution limit, one figure per calendar year. Elections BC
 * indexes it every January; entering next year's figure here makes every
 * check and every public mention switch at midnight on January 1, Pacific.
 */
export default async function LimitsPage() {
  await requireAdmin("money");
  const rows = await listLimits(getDb());
  const thisYear = pacificYear(new Date());
  const stored = new Set(rows.map((r) => r.year));
  const nextToAdd = stored.has(thisYear) ? Math.max(thisYear + 1, ...rows.map((r) => r.year + 1)) : thisYear;
  const fallback = env.contributionLimitCents;

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Contribution limits</h1>
        <nav className="crm-sub" aria-label="Related">
          <Link href="/admin/desk-gifts">Gifts to log at the desk</Link>
        </nav>
      </div>
      <p style={{ maxWidth: 760 }}>
        BC’s annual contribution limit per person, by calendar year (Pacific time). Elections BC indexes it every January. Every gift, membership and monthly
        payment is checked against the limit for the year it is paid in, and the donate page, the forms and the supporter portal show this year’s. A year with no
        figure here uses <code>CONTRIBUTION_LIMIT_CENTS</code> ({formatCents(fallback)}). Base Ground keeps its own figure: change it there too.
      </p>

      <div className="profile-grid">
        <div className="stack" style={{ gap: 24 }}>
          <section className="profile-card" aria-labelledby="years-title">
            <h2 id="years-title">Years</h2>
            {rows.length === 0 ? (
              <p className="small">No years stored yet. Every year uses {formatCents(fallback)}.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Contribution limit by year, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Year</th>
                      <th scope="col">Limit</th>
                      <th scope="col">Source</th>
                      <th scope="col">Last changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.year} data-year={r.year}>
                        <th scope="row">
                          {r.year}
                          {r.year === thisYear ? " (this year)" : ""}
                        </th>
                        <td>{formatCents(r.cents)}</td>
                        <td>{r.note ?? ""}</td>
                        <td className="small">
                          {WHEN.format(r.updatedAt)}
                          {r.updatedBy ? ` · ${r.updatedBy}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="profile-card" aria-labelledby="add-title">
            <h2 id="add-title">Add a year</h2>
            <LimitForm action={saveLimitAction} idPrefix="add" year={nextToAdd} submitLabel="Add this year" />
          </section>
        </div>

        <div className="stack" style={{ gap: 24 }}>
          {rows.map((r) => (
            <section key={r.year} className="profile-card" aria-labelledby={`edit-${r.year}-title`}>
              <h2 id={`edit-${r.year}-title`}>Change {r.year}</h2>
              <LimitForm
                action={saveLimitAction}
                idPrefix={`edit-${r.year}`}
                year={r.year}
                fixedYear
                amount={dollars(r.cents)}
                note={r.note ?? ""}
                submitLabel={`Save ${r.year}`}
              />
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
