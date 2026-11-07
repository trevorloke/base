import Link from "next/link";
import { OutboxRowActions } from "@/components/admin/content/IntegrationTests";
import { getDb } from "@/lib/db";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { listOutbox, OUTBOX_KINDS, OUTBOX_PAGE_SIZE, OUTBOX_STATUSES, outboxStats, parseOutboxFilters, type OutboxFilters } from "@/lib/server/base-ground-outbox";
import "../../people/people.css";

const WHEN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const TONE: Record<string, string> = { sent: "badge--ok", pending: "badge--warn", failed: "badge--bad", skipped: "" };

function href(f: OutboxFilters, page: number): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.kind) p.set("kind", f.kind);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/admin/integrations/base-ground?${s}` : "/admin/integrations/base-ground";
}

/** Who a row is about when it isn't linked to a supporter here (a text STOP from an unknown number). */
function payloadContact(payload: Record<string, unknown>): string {
  const v = payload.email ?? payload.phone;
  return typeof v === "string" && v ? v : "—";
}

/** Everything the website has queued for base ground, newest first, with Retry and Skip. */
export default async function BaseGroundOutboxPage({ searchParams }: PageProps<"/admin/integrations/base-ground">) {
  const user = await requireAdmin("integrations");
  const filters = parseOutboxFilters(await searchParams);
  const db = getDb();
  const [{ rows, total }, stats] = await Promise.all([listOutbox(db, filters), outboxStats(db)]);
  const notSupported = stats.consent.notSupported;
  const pages = Math.max(1, Math.ceil(total / OUTBOX_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const people = can(user, "people");

  return (
    <>
      <div className="crm-head">
        <div>
          <p className="small">
            <Link href="/admin/integrations">Integrations</Link> / base ground
          </p>
          <h1 className="h3">Sent to base ground (the desk)</h1>
        </div>
      </div>
      <p style={{ maxWidth: 760 }}>
        Each row is one sign-up, portal edit, tag or consent withdrawal the website forwarded, and exactly what was sent. Its id is the Idempotency-Key, so sending it again
        never makes a second person in base ground. Waiting rows are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, then every 12 hours, and marked refused after 8
        attempts.
      </p>
      {notSupported > 0 && (
        <p className="alert alert--note" role="note" style={{ maxWidth: 760 }}>
          {notSupported} unsubscribe{notSupported === 1 ? "" : "s"} and STOP{notSupported === 1 ? "" : "s"} (kind “consent”) {notSupported === 1 ? "is" : "are"} waiting because
          this base ground doesn&apos;t take consent changes yet (it answers 404 at /in/v1/consent). {notSupported === 1 ? "It isn't" : "They aren't"} failed: each is tried again every
          6 hours and with Send now, and goes once base ground has the endpoint.
        </p>
      )}

      <form method="get" action="/admin/integrations/base-ground" className="crm-filters" aria-label="Filter the outbox">
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" name="status" className="input input--compact" defaultValue={filters.status}>
            <option value="">Any</option>
            {OUTBOX_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kind">Kind</label>
          <select id="kind" name="kind" className="input input--compact" defaultValue={filters.kind}>
            <option value="">Any</option>
            {OUTBOX_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="crm-filters__actions">
          <button type="submit" className="btn btn--navy btn--compact">
            Apply
          </button>
          {(filters.status || filters.kind) && (
            <Link href="/admin/integrations/base-ground" className="btn btn--outline btn--compact">
              Clear
            </Link>
          )}
        </div>
      </form>

      <p className="small" role="status" style={{ marginBottom: 12 }}>
        {total} row{total === 1 ? "" : "s"}
        {pages > 1 && ` · page ${page} of ${pages}`}
      </p>

      {rows.length === 0 ? (
        <p className="empty-state">Nothing matches.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Sign-ups forwarded to base ground</caption>
            <thead>
              <tr>
                <th scope="col">Queued</th>
                <th scope="col">Kind</th>
                <th scope="col">Supporter</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last error</th>
                <th scope="col">Sent</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-outbox={r.id} data-status={r.status}>
                  <td>{WHEN.format(r.createdAt)}</td>
                  <td>{r.kind}</td>
                  <td className="cell-wrap">
                    {r.personId && people ? <Link href={`/admin/people/${r.personId}`}>{r.email ?? "supporter"}</Link> : (r.email ?? payloadContact(r.payload))}
                    <details>
                      <summary className="small">What was sent</summary>
                      <pre className="details-json">{JSON.stringify(r.payload, null, 2)}</pre>
                      <span className="small">Idempotency-Key: {r.id}</span>
                    </details>
                  </td>
                  <td>
                    <span className={`badge ${TONE[r.status] ?? ""}`}>{r.status}</span>
                    {r.status === "pending" && r.nextAttemptAt && (
                      <span className="small" style={{ display: "block" }}>
                        next try {WHEN.format(r.nextAttemptAt)}
                      </span>
                    )}
                  </td>
                  <td>{r.attempts}</td>
                  <td className="cell-wrap">{r.lastError ?? ""}</td>
                  <td className="cell-wrap">
                    {r.sentAt ? WHEN.format(r.sentAt) : ""}
                    {r.baseGroundPersonId && (
                      <span className="small" style={{ display: "block" }}>
                        base ground id {r.baseGroundPersonId}
                      </span>
                    )}
                  </td>
                  <td>
                    <OutboxRowActions id={r.id} status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="crm-pager" aria-label="Pages">
          {page > 1 && (
            <Link href={href(filters, page - 1)} rel="prev">
              Previous
            </Link>
          )}
          <span aria-current="page">{page}</span>
          {page < pages && (
            <Link href={href(filters, page + 1)} rel="next">
              Next
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
