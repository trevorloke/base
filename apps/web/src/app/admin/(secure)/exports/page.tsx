import Link from "next/link";
import { getDb } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { DATASETS, datasetPermission, loadDataset, type Dataset } from "@/lib/server/admin-data";
import { ISO_DATE_RE } from "@/lib/shifts";
import "../people/people.css";

const LABELS: Record<Dataset, string> = {
  members: "Members",
  contributions: "Contributions",
  monthly_donors: "Monthly donors",
  newsletter: "Newsletter",
  signatures: "Petitions & pledges",
  rsvps: "RSVPs",
  shifts: "Shifts",
  orders: "Shop orders",
};

const PREVIEW_ROWS = 200;

function cell(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString("en-CA", { timeZone: "America/Vancouver" });
  if (key.endsWith("_cents") && typeof value === "number") return formatCents(value);
  if (typeof value === "boolean") return value ? "yes" : "";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

/** The dataset tables and CSV downloads. Timestamps are already Pacific, formatted in SQL. */
export default async function AdminExports({ searchParams }: PageProps<"/admin/exports">) {
  const user = await requireAdmin();
  const sp = await searchParams;
  const allowed = DATASETS.filter((d) => can(user, datasetPermission(d)));
  const view = allowed.includes(sp.view as Dataset) ? (sp.view as Dataset) : allowed[0];
  const date = (v: unknown) => (typeof v === "string" && ISO_DATE_RE.test(v) ? v : undefined);
  const options = view === "shifts" ? { from: date(sp.from), to: date(sp.to) } : {};
  const rows = view ? await loadDataset(getDb(), view, PREVIEW_ROWS, options) : [];
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const csvParams = new URLSearchParams();
  if (options.from) csvParams.set("from", options.from);
  if (options.to) csvParams.set("to", options.to);
  const csvHref = `/api/admin/export/${view}${csvParams.size ? `?${csvParams}` : ""}`;

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Exports</h1>
        <p className="small">Every dataset as a table and a CSV. The CSV has every row; the table shows the latest {PREVIEW_ROWS}.</p>
        <nav className="crm-sub" aria-label="Related">
          <Link href="/admin">Dashboard</Link>
          {can(user, "people") && <Link href="/admin/people">Supporters</Link>}
        </nav>
      </div>

      {!view ? (
        <p className="empty-state">Your role has no datasets to export.</p>
      ) : (
        <>
          <nav aria-label="Datasets" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {allowed.map((d) => (
              <Link key={d} href={`/admin/exports?view=${d}`} className={`btn btn--compact ${d === view ? "btn--primary" : "btn--outline"}`} aria-current={d === view ? "page" : undefined}>
                {LABELS[d]}
              </Link>
            ))}
          </nav>

          <div className="crm-toolbar">
            {view === "shifts" ? (
              <form method="get" action="/admin/exports" className="bulk" style={{ margin: 0, flex: "1 1 420px" }}>
                <input type="hidden" name="view" value="shifts" />
                <div className="field">
                  <label htmlFor="from">From</label>
                  <input id="from" name="from" type="date" className="input input--compact" defaultValue={options.from ?? ""} />
                </div>
                <div className="field">
                  <label htmlFor="to">To</label>
                  <input id="to" name="to" type="date" className="input input--compact" defaultValue={options.to ?? ""} />
                </div>
                <div className="bulk__buttons">
                  <button type="submit" className="btn btn--outline btn--compact">
                    Show
                  </button>
                </div>
                <p className="small" style={{ flexBasis: "100%" }}>
                  Leave both blank for every shift ever scheduled.
                </p>
              </form>
            ) : (
              <p className="small">
                Showing the latest {rows.length} {LABELS[view].toLowerCase()}.
              </p>
            )}
            <a href={csvHref} className="btn btn--accent btn--compact">
              Download {LABELS[view]} CSV
            </a>
          </div>

          {rows.length === 0 ? (
            <p className="empty-state">Nothing here yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{LABELS[view]}</caption>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} scope="col">
                        {c.replace(/_/g, " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <td key={c} className={c === "unsubscribe_url" || c === "items" || c === "ship_address" ? "cell-wrap" : undefined}>
                          {cell(c, r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
