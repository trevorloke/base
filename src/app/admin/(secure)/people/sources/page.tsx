import Link from "next/link";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { sourcesReport } from "@/lib/server/supporters";
import "../people.css";

const DAYS = 90;

/** Where supporters come from: sign-up sources and the relational organizers bringing people in. */
export default async function SourcesPage() {
  await requireAdmin("people");
  const report = await sourcesReport(getDb(), DAYS);
  const total = report.sources.reduce((n, s) => n + s.total, 0);

  return (
    <>
      <div className="crm-head">
        <div>
          <p className="small">
            <Link href="/admin/people">Supporters</Link> / sources
          </p>
          <h1 className="h3">Where sign-ups come from</h1>
        </div>
        <p className="small">The last {DAYS} days: new supporter records, petition and pledge signatures, and event RSVPs, by the source each form recorded.</p>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="value">{total}</div>
          <div className="label">Sign-ups in {DAYS} days</div>
        </div>
        <div className="stat">
          <div className="value">{report.referralSignups}</div>
          <div className="label">New supporters via a share code</div>
        </div>
        <div className="stat">
          <div className="value">{report.referrers.filter((r) => r.recent > 0).length}</div>
          <div className="label">Active referrers</div>
        </div>
      </div>

      <section aria-labelledby="sources-title" style={{ marginBottom: 32 }}>
        <h2 id="sources-title" className="h3" style={{ fontSize: 22, marginBottom: 12 }}>
          By source
        </h2>
        {report.sources.length === 0 ? (
          <p className="empty-state">No sign-ups in the last {DAYS} days.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Sign-ups by source over the last {DAYS} days</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">New supporters</th>
                  <th scope="col">Signatures</th>
                  <th scope="col">RSVPs</th>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.sources.map((s) => (
                  <tr key={s.source}>
                    <td>{s.source.startsWith("(") ? s.source : <Link href={`/admin/people?source=${encodeURIComponent(s.source)}`}>{s.source}</Link>}</td>
                    <td>{s.people}</td>
                    <td>{s.signatures}</td>
                    <td>{s.rsvps}</td>
                    <td>
                      <strong>{s.total}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="referrers-title">
        <h2 id="referrers-title" className="h3" style={{ fontSize: 22, marginBottom: 12 }}>
          Top referrers
        </h2>
        {report.referrers.length === 0 ? (
          <p className="empty-state">No one has brought in a supporter with their share code yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Supporters who referred others</caption>
              <thead>
                <tr>
                  <th scope="col">Referrer</th>
                  <th scope="col">Share code</th>
                  <th scope="col">Last {DAYS} days</th>
                  <th scope="col">All time</th>
                </tr>
              </thead>
              <tbody>
                {report.referrers.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/admin/people/${r.id}`}>{r.name}</Link>
                      <span className="small" style={{ display: "block" }}>
                        {r.email}
                      </span>
                    </td>
                    <td>{r.code}</td>
                    <td>{r.recent}</td>
                    <td>{r.allTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
