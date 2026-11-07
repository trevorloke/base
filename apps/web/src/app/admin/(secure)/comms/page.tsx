import Link from "next/link";
import { ResendButton } from "@/components/admin/comms/ResendButton";
import { StatusBadge } from "@/components/admin/comms/StatusBadge";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { commsTotals, loadEmailLog, loadSmsLog, logKinds, pastCampaigns } from "@/lib/server/comms";
import "./comms.css";

const STATUSES = ["queued", "sent", "failed", "skipped"];
const when = (d: Date | null) => (d ? d.toLocaleString("en-CA", { timeZone: "America/Vancouver", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const str = (v: unknown, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * The email and text log. Newsletters, campaign emails and text blasts go out
 * from base ground; the website sends only transactional messages (confirmations,
 * receipts, reminders, tracker alerts, sign-in links) and answers texts sent
 * to its number, and every one of them is listed here.
 */
export default async function CommsLog({ searchParams }: PageProps<"/admin/comms">) {
  const user = await requireAdmin("comms");
  const sp = await searchParams;
  const filter = { status: STATUSES.includes(str(sp.status)) ? str(sp.status) : undefined, kind: str(sp.kind) || undefined, q: str(sp.q) || undefined };
  const channel = sp.channel === "email" || sp.channel === "sms" ? sp.channel : "all";
  const db = getDb();
  const [emails, texts, kinds, totals, campaigns] = await Promise.all([
    channel === "sms" ? [] : loadEmailLog(db, filter),
    channel === "email" ? [] : loadSmsLog(db, filter),
    logKinds(db),
    commsTotals(db),
    pastCampaigns(db),
  ]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="comms-head">
        <h1 className="h3">Email &amp; text log</h1>
      </div>

      <div role="note" className="alert alert--note" style={{ maxWidth: 820 }}>
        <span aria-hidden="true" className="alert-icon">
          i
        </span>
        <span>
          Newsletters, campaign emails and text blasts go out from <strong>base ground</strong>, which has the full list. This website sends only transactional messages
          (confirmations, receipts, reminders, promise-tracker alerts and sign-in links) and answers texts sent to its number, including STOP and START. Every unsubscribe and
          STOP here is passed to base ground{can(user, "integrations") ? <> (<Link href="/admin/integrations/base-ground?kind=consent">see them</Link>)</> : null}.
          {!env.emailEnabled && " Email isn't configured yet, so messages are logged as skipped."}
        </span>
      </div>

      <div className="stats" style={{ marginBottom: 0 }}>
        <div className="stat">
          <div className="value">{totals.confirmed}</div>
          <div className="label">Confirmed subscribers</div>
        </div>
        <div className="stat">
          <div className="value">{totals.pending}</div>
          <div className="label">Awaiting confirmation</div>
        </div>
        <div className="stat">
          <div className="value">{totals.unsubscribed}</div>
          <div className="label">Unsubscribed</div>
        </div>
        <div className="stat">
          <div className="value">{totals.sms_opt_ins}</div>
          <div className="label">Said yes to texts</div>
        </div>
        <div className="stat">
          <div className="value">{totals.queued}</div>
          <div className="label">Emails queued</div>
        </div>
        <div className="stat">
          <div className="value">{totals.failed}</div>
          <div className="label">Emails failed</div>
        </div>
      </div>

      <form method="get" action="/admin/comms" className="log-filters" aria-label="Filter the log">
        <div className="field">
          <label htmlFor="f-channel">Channel</label>
          <select id="f-channel" name="channel" className="input" defaultValue={channel}>
            <option value="all">Email and texts</option>
            <option value="email">Email only</option>
            <option value="sms">Texts only</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" name="status" className="input" defaultValue={filter.status ?? ""}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-kind">Kind</label>
          <select id="f-kind" name="kind" className="input" defaultValue={filter.kind ?? ""}>
            <option value="">Any kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-q">Address or subject</label>
          <input id="f-q" name="q" type="search" className="input input--search" defaultValue={filter.q ?? ""} maxLength={100} />
        </div>
        <button type="submit" className="btn btn--primary" style={{ minHeight: 44 }}>
          Filter
        </button>
      </form>

      {channel !== "sms" && (
        <section className="stack" style={{ gap: 10 }}>
          <h2 className="h3" style={{ fontSize: 20 }}>
            Emails <span className="small">(latest {emails.length})</span>
          </h2>
          {emails.length === 0 ? (
            <p className="empty-state">No emails match.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">To</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {emails.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.sentAt ?? e.createdAt)}</td>
                      <td>{e.to}</td>
                      <td>{e.kind}</td>
                      <td className="wrap">{e.subject}</td>
                      <td>
                        <StatusBadge status={e.status} />
                        {e.error && <span className="error-text">{e.error}</span>}
                        {e.attempts > 1 && <span className="small"> · {e.attempts} attempts</span>}
                      </td>
                      <td>{e.status === "failed" && !e.campaignId && e.hasBody && <ResendButton id={e.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {channel !== "email" && (
        <section className="stack" style={{ gap: 10 }}>
          <h2 className="h3" style={{ fontSize: 20 }}>
            Texts <span className="small">(latest {texts.length})</span>
          </h2>
          {texts.length === 0 ? (
            <p className="empty-state">No texts match.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Number</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Message</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {texts.map((t) => (
                    <tr key={t.id}>
                      <td>{when(t.sentAt ?? t.createdAt)}</td>
                      <td>{t.to}</td>
                      <td>{t.kind}</td>
                      <td className="wrap" style={{ whiteSpace: "pre-wrap" }}>
                        {t.body}
                      </td>
                      <td>
                        <StatusBadge status={t.status} />
                        {t.error && <span className="error-text">{t.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {campaigns.length > 0 && (
        <section className="stack" style={{ gap: 10 }}>
          <h2 className="h3" style={{ fontSize: 20 }}>
            Earlier campaigns <span className="small">(sent from this website before base ground took over)</span>
          </h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col">Status</th>
                  <th scope="col">Recipients</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Failed</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td className="wrap">{c.subject}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{c.recipientCount}</td>
                    <td>{c.sentCount}</td>
                    <td>{c.failedCount}</td>
                    <td>{when(c.sentAt ?? c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
