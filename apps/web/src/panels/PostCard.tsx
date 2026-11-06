import { useMemo, useState } from "react";
import type { DecideInput, PostSummary, Violation } from "../types";
import { api, errorText, isApiError } from "../api";
import { NetworkBadge } from "../components/NetworkBadge";
import { Pill, StagePill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { actionClassLabel, actorLabel, atHandle, evidenceKindLabel, isUrl, NETWORK_MAX_TEXT, networkLabel, plural, truncate, violationText } from "../lib/format";
import { formatDateTime, relativeTime } from "../lib/time";
import { useRoom } from "../lib/room";

type Decision = "approve" | "reject";

/** One proposal waiting on a human. Everything needed to decide is on the card. */
export function PostCard({ item, onDecided }: { item: PostSummary; onDecided: (id: string, decision: Decision) => void }) {
  const { post, variants } = item;
  const { accountsById, topicsById, openPost, openTopic } = useRoom();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Decision | null>(null);
  const [blocked, setBlocked] = useState<Violation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topic = post.trendTopicId ? topicsById.get(post.trendTopicId) : undefined;
  const flagged = post.policyDecision?.verdict === "require_approval" ? post.policyDecision.violations : [];
  const title = post.title ?? truncate(post.body, 90);

  const edits = useMemo(() => {
    const out: Record<string, string> = {};
    for (const v of variants) {
      const d = drafts[v.id];
      if (d !== undefined && d !== v.text) out[v.id] = d;
    }
    return out;
  }, [drafts, variants]);
  const editCount = Object.keys(edits).length;

  async function decide(decision: Decision) {
    setBusy(decision);
    setError(null);
    setBlocked(null);
    try {
      const input: DecideInput = { decision };
      if (decision === "approve" && editCount > 0) input.edits = edits;
      const result = await api.decide(post.id, input);
      if (decision === "approve") {
        const when = result.post.scheduledAt ? ` · goes out ${relativeTime(result.post.scheduledAt)}` : "";
        toast(`Approved${editCount ? " with edits" : ""}${when}`);
      } else {
        toast("Rejected");
      }
      onDecided(post.id, decision);
    } catch (e) {
      if (isApiError(e) && e.status === 422) {
        setBlocked(extractViolations(e.details));
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="card" aria-label={title}>
      <header className="card-head">
        <div className="card-meta">
          <span className="card-actor">{actorLabel(post.createdBy)}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>{actionClassLabel(post.actionClass)}</span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <RelativeTime iso={post.createdAt} />
          {post.disclosure?.aiAssisted ? <Pill tone="info">AI-assisted</Pill> : null}
        </div>
        <button type="button" className="card-title linkish" onClick={() => openPost(post.id)}>
          {title}
        </button>
        {topic || post.trendStageAtCreation ? (
          <div className="card-trend">
            <span className="muted">Rides</span>
            {topic ? (
              <button type="button" className="linkish strong" onClick={() => openTopic(topic.id)}>
                {topic.name}
              </button>
            ) : (
              <span className="muted">a topic no longer on the radar</span>
            )}
            {post.trendStageAtCreation ? <StagePill stage={post.trendStageAtCreation} title="Stage when this was proposed" /> : null}
          </div>
        ) : null}
        {post.scheduledAt ? (
          <div className="card-when muted">
            Scheduled for <time className="mono">{formatDateTime(post.scheduledAt)}</time>
          </div>
        ) : null}
      </header>

      <div className="card-variants">
        {variants.map((v) => {
          const account = accountsById.get(v.socialAccountId);
          const text = drafts[v.id] ?? v.text;
          const max = NETWORK_MAX_TEXT[v.network] ?? 0;
          const over = max > 0 && text.length > max;
          return (
            <div key={v.id} className="variant">
              <div className="variant-head">
                <NetworkBadge network={v.network} />
                {account ? <span className="muted">{atHandle(account.handle, account.network)}</span> : null}
                {editing ? (
                  <span className={`mono variant-count${over ? " over" : ""}`}>
                    {text.length}
                    {max > 0 ? `/${max}` : ""}
                  </span>
                ) : null}
              </div>
              {editing ? (
                <textarea
                  className="variant-edit"
                  value={text}
                  rows={3}
                  aria-label={`${networkLabel(v.network)} text`}
                  onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
                />
              ) : (
                <p className={`variant-text${edits[v.id] !== undefined ? " variant-edited" : ""}`}>{text}</p>
              )}
              {v.thread.length > 0 ? <div className="muted small">+{plural(v.thread.length, "more segment")}</div> : null}
              {v.media.length > 0 ? <div className="muted small">{plural(v.media.length, "attachment")}</div> : null}
            </div>
          );
        })}
      </div>

      {post.evidence.length > 0 ? (
        <section className="card-section">
          <h4 className="card-h">Evidence</h4>
          <ul className="evidence">
            {post.evidence.map((ev, i) => (
              <li key={i}>
                <span className="ev-kind">{evidenceKindLabel(ev.kind)}</span>
                <EvidenceRef value={ev.ref} />
                {ev.note ? <span className="ev-note">{ev.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {flagged.length > 0 && !blocked ? (
        <section className="card-section card-flag">
          <h4 className="card-h">Flagged by a red line · your call</h4>
          <ul className="violations">
            {flagged.map((v, i) => (
              <li key={i}>
                {violationText(v.message)}
                {v.matches.length ? <span className="mono match">{v.matches.join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {blocked ? (
        <section className="card-section card-blocked" role="alert">
          <h4 className="card-h">Blocked by a red line</h4>
          {blocked.length ? (
            <ul className="violations">
              {blocked.map((v, i) => (
                <li key={i}>
                  {violationText(v.message)}
                  {v.matches.length ? <span className="mono match">{v.matches.join(", ")}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>The edit crosses a red line. Change the text and try again.</p>
          )}
        </section>
      ) : null}

      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}

      <footer className="card-actions">
        {(() => {
          const overNet = variants.find((v) => {
            const max = NETWORK_MAX_TEXT[v.network] ?? 0;
            return max > 0 && (drafts[v.id] ?? v.text).length > max;
          });
          return (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || !!overNet}
                title={overNet ? `${networkLabel(overNet.network)} text is over ${NETWORK_MAX_TEXT[overNet.network]} characters` : undefined}
                onClick={() => void decide("approve")}
              >
                {busy === "approve" ? "Approving…" : editCount > 0 ? `Approve with ${plural(editCount, "edit")}` : "Approve"}
              </button>
              {overNet ? <span className="muted small">{networkLabel(overNet.network)} text is over {NETWORK_MAX_TEXT[overNet.network]} characters</span> : null}
            </>
          );
        })()}
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide("reject")}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setEditing((e) => !e)}>
          {editing ? "Done editing" : "Edit"}
        </button>
        {editCount > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={() => setDrafts({})}>
            Revert
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function EvidenceRef({ value }: { value: string }) {
  if (isUrl(value)) {
    let label = value;
    try {
      const u = new URL(value);
      label = u.host.replace(/^www\./, "") + (u.pathname && u.pathname !== "/" ? truncate(u.pathname, 22) : "");
    } catch {
      label = truncate(value, 40);
    }
    return (
      <a className="ev-ref" href={value} target="_blank" rel="noopener noreferrer">
        {label} ↗
      </a>
    );
  }
  return <span className="ev-ref">{value}</span>;
}

/** The 422 body's `details` isn't pinned down by the contract; accept the two obvious shapes. */
function extractViolations(details: unknown): Violation[] {
  if (!details || typeof details !== "object") return [];
  const d = details as { violations?: unknown; decision?: { violations?: unknown } };
  const list = Array.isArray(d.violations) ? d.violations : Array.isArray(d.decision?.violations) ? d.decision.violations : [];
  return list.filter((v): v is Violation => !!v && typeof v === "object" && typeof (v as Violation).message === "string");
}
