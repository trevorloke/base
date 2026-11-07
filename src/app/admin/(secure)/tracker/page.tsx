import Link from "next/link";
import { StatusBadge } from "@/components/tracker/PromiseList";
import { formatDate } from "@/lib/dates";
import { todayInSurrey } from "@/lib/shifts";
import { countByStatus, dueInfo, formatIsoDate, PROMISE_STATUSES } from "@/lib/tracker";
import { requireAdmin } from "@/lib/server/admin-auth";
import { loadTrackerFresh } from "@/lib/server/tracker";
import { AddAnnouncementForm, AddPromiseForm, DeleteAnnouncementForm, DeletePromiseForm, DeleteUpdateForm, EditPromiseForm, SetStatusForm, UpdateForm } from "./forms";

export default async function AdminTracker() {
  await requireAdmin("tracker");
  // The admin reads the database directly so a score it just set is never stale.
  const { promises, announcements } = await loadTrackerFresh();
  const today = todayInSurrey();
  const counts = countByStatus(promises.map((p) => p.status));
  const areas = [...new Set(promises.map((p) => p.area))].sort();
  const nextNumber = promises.length ? Math.max(...promises.map((p) => p.number)) + 1 : 1;

  return (
    <div className="stack" style={{ gap: 40 }}>
      <div className="stack" style={{ gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
          <h1 className="h3" style={{ fontSize: 30 }}>
            Promise tracker
          </h1>
          <Link href="/tracker" className="text-link" target="_blank">
            View public page ↗
          </Link>
          <Link href="/tracker/methodology" className="text-link" target="_blank">
            Methodology ↗
          </Link>
        </div>
        <p className="body" style={{ maxWidth: 860 }}>
          Score a promise when the record exists: add an update with the date, what happened and a link to the record, and pick the new status. Updates
          show on the public page, newest first; a status change emails everyone following the promise. New commitments go in the announcements log, or
          as a new promise if they can be scored.
        </p>
        <div className="btn-row" style={{ gap: 8 }}>
          {PROMISE_STATUSES.map((s) => (
            <span key={s.id} className="status-badge" style={{ background: s.color, color: s.text }}>
              {counts[s.id]} {s.label}
            </span>
          ))}
        </div>
      </div>

      <section className="stack" style={{ gap: 12 }}>
        {promises.map((p) => {
          const due = dueInfo({ status: p.status, targetDate: p.targetDate, promisedOn: p.promisedOn, hasRecord: p.updates.length > 0 }, today);
          return (
            <details key={p.id} className="card card--white" style={{ padding: 0 }}>
              <summary style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", padding: "16px 20px", cursor: "pointer" }}>
                <strong style={{ fontSize: 20, color: "var(--navy)", minWidth: 28 }}>{p.number}</strong>
                <StatusBadge status={p.status} />
                <span style={{ flex: "1 1 300px", fontWeight: 700 }}>{p.title}</span>
                <span className="small">
                  {p.area} · {p.updates.length} update{p.updates.length === 1 ? "" : "s"}
                  {due ? ` · ${due.label}` : ""}
                </span>
              </summary>
              <div className="stack" style={{ gap: 20, padding: "0 20px 20px" }}>
                <p className="small" style={{ margin: 0 }}>
                  {p.statusChangedAt ? `Status set ${formatDate(new Date(p.statusChangedAt))}.` : "Status never changed."}
                  {p.promisedOn ? ` Promised ${formatIsoDate(p.promisedOn)}.` : ""}
                  {p.targetDate ? ` Due ${formatIsoDate(p.targetDate)}.` : ""}
                  {p.neighbourhoods.length ? ` Neighbourhoods: ${p.neighbourhoods.join(", ")}.` : ""}{" "}
                  <Link href={`/tracker/${p.number}`} target="_blank">
                    Public page ↗
                  </Link>
                </p>
                <UpdateForm promise={p} today={today} />

                {p.updates.length > 0 && (
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {p.updates.map((u) => (
                          <tr key={u.id}>
                            <td>{u.date}</td>
                            <td>{u.status && <StatusBadge status={u.status} />}</td>
                            <td style={{ whiteSpace: "normal" }}>
                              {u.note} {u.url && <a href={u.url}>link</a>}
                            </td>
                            <td>
                              <DeleteUpdateForm id={u.id} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <SetStatusForm promise={p} />

                <details>
                  <summary className="link-button">Edit wording, dates, neighbourhoods and delivery test</summary>
                  <EditPromiseForm promise={p} />
                  <DeletePromiseForm promise={p} />
                </details>
              </div>
            </details>
          );
        })}
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <h2 className="h3" style={{ fontSize: 24 }}>
          Add a new promise
        </h2>
        <AddPromiseForm nextNumber={nextNumber} areas={areas} />
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <h2 className="h3" style={{ fontSize: 24 }}>
          Announcements log
        </h2>
        <AddAnnouncementForm today={today} />
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {announcements.map((a) => (
                <tr key={a.id}>
                  <td>{a.dateLabel}</td>
                  <td style={{ whiteSpace: "normal" }}>
                    <strong>{a.title}</strong>
                  </td>
                  <td>
                    <DeleteAnnouncementForm announcement={a} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
