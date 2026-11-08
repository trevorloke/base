import Link from "next/link";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { AUDIT_PAGE_SIZE, auditFacets, listAudit, parseAuditFilters, type AuditFilters } from "@/lib/server/staff";
import "../people/people.css";

const WHEN = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

function href(f: AuditFilters, page: number): string {
  const p = new URLSearchParams();
  if (f.user) p.set("user", f.user);
  if (f.action) p.set("action", f.action);
  if (f.entity) p.set("entity", f.entity);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return s ? `/admin/audit?${s}` : "/admin/audit";
}

function entityHref(entity: string | null, id: string | null): string | null {
  if (!id) return null;
  if (entity === "person") return `/admin/people/${id}`;
  if (entity === "admin_user") return "/admin/users";
  return null;
}

/** Who changed what in the admin. Owners only (the "users" permission). */
export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin("users");
  const filters = parseAuditFilters(await searchParams);
  const db = getDb();
  const [{ rows, total }, facets] = await Promise.all([listAudit(db, filters), auditFacets(db)]);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(filters.page, pages);

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Audit log</h1>
        <nav className="crm-sub" aria-label="Related">
          <Link href="/admin/users">Staff accounts</Link>
        </nav>
      </div>

      <form method="get" action="/admin/audit" className="crm-filters" aria-label="Filter the audit log">
        <div className="field">
          <label htmlFor="user">Staff member</label>
          <select id="user" name="user" className="input input--compact" defaultValue={filters.user}>
            <option value="">Anyone</option>
            {facets.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
            <option value="system">System (no user)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="action">Action</label>
          <select id="action" name="action" className="input input--compact" defaultValue={filters.action}>
            <option value="">Any</option>
            {!facets.actions.includes(filters.action) && filters.action && <option value={filters.action}>{filters.action}</option>}
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="entity">Entity or id</label>
          <input id="entity" name="entity" className="input input--compact" defaultValue={filters.entity} maxLength={120} placeholder="person, admin_user, or a record id" />
        </div>
        <div className="crm-filters__actions">
          <button type="submit" className="btn btn--primary btn--compact">
            Apply
          </button>
          {(filters.user || filters.action || filters.entity) && (
            <Link href="/admin/audit" className="btn btn--outline btn--compact">
              Clear
            </Link>
          )}
        </div>
      </form>

      <p className="small" role="status" style={{ marginBottom: 12 }}>
        {total} entr{total === 1 ? "y" : "ies"}
        {pages > 1 && ` · page ${page} of ${pages}`}
      </p>

      {rows.length === 0 ? (
        <p className="empty-state">No entries match.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Audit log entries</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const link = entityHref(r.entity, r.entityId);
                return (
                  <tr key={r.id}>
                    <td>{WHEN.format(r.at)}</td>
                    <td>{r.userName ?? r.userEmail ?? "system"}</td>
                    <td>{r.action}</td>
                    <td className="cell-wrap">
                      {r.entity ?? ""}
                      {r.entityId && (
                        <span className="small" style={{ display: "block" }}>
                          {link ? <Link href={link}>{r.entityId}</Link> : r.entityId}
                        </span>
                      )}
                    </td>
                    <td className="cell-wrap">{r.details ? <pre className="details-json">{JSON.stringify(r.details)}</pre> : ""}</td>
                  </tr>
                );
              })}
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
