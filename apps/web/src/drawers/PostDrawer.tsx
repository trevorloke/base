import { useEffect, useState } from "react";
import type { LedgerEvent, PostFull, PostStatus, VariantStatus } from "../types";
import { api, errorText } from "../api";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { Pill, StagePill, type PillTone } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import {
  actorLabel,
  actorPhrase,
  atHandle,
  compact,
  evidenceKindLabel,
  isUrl,
  lift,
  networkLabel,
  plural,
  POST_STATUS_LABEL,
  truncate,
  VARIANT_STATUS_LABEL,
} from "../lib/format";
import { formatDateTime } from "../lib/time";
import { useRoom } from "../lib/room";

const STATUS_TONE: Record<PostStatus, PillTone> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  scheduled: "info",
  publishing: "info",
  published: "good",
  partially_published: "warn",
  failed: "bad",
  cancelled: "neutral",
  blocked: "bad",
};

const VARIANT_TONE: Record<VariantStatus, PillTone> = {
  pending: "neutral",
  publishing: "info",
  published: "good",
  failed: "bad",
  skipped: "neutral",
};

export function PostDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { accountsById, topicsById, openTopic } = useRoom();
  const [data, setData] = useState<PostFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .post(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const post = data?.post;
  const title = post ? (post.title ?? truncate(post.body, 80)) : "Post";
  const topic = post?.trendTopicId ? topicsById.get(post.trendTopicId) : undefined;
  const history = data ? [...data.history].sort((a, b) => a.seq - b.seq) : [];

  return (
    <Drawer
      title={title}
      subtitle={
        post ? (
          <>
            <Pill tone={STATUS_TONE[post.status]}>{POST_STATUS_LABEL[post.status]}</Pill>
            <span className="muted">
              {actorLabel(post.createdBy)} · <RelativeTime iso={post.createdAt} />
            </span>
          </>
        ) : null
      }
      onClose={onClose}
    >
      <PanelState error={error} loading={!data && !error} />
      {data && post ? (
        <>
          <section className="dsec">
            <h3 className="section-h">The idea</h3>
            <p className="body-text">{post.body}</p>
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
            {post.disclosure ? (
              <p className="muted small">
                {post.disclosure.aiAssisted
                  ? `AI-assisted (${(post.disclosure.aiContributions ?? []).map((c) => c.replace(/_/g, " ")).join(", ") || "drafted"})`
                  : "Written by a human"}
                {" · "}
                {post.disclosure.humanReviewed ? `reviewed by ${post.disclosure.reviewedBy ?? "a human"}` : "not yet reviewed by a human"}
              </p>
            ) : null}
            {post.scheduledAt && !post.publishedAt ? (
              <p className="muted small">
                Scheduled for <time className="mono">{formatDateTime(post.scheduledAt)}</time>
              </p>
            ) : null}
          </section>

          <section className="dsec">
            <h3 className="section-h">{plural(data.variants.length, "variant")}</h3>
            {data.variants.map((v) => {
              const account = accountsById.get(v.socialAccountId);
              return (
                <div key={v.id} className={`variant variant-${v.status}`}>
                  <div className="variant-head">
                    <NetworkBadge network={v.network} />
                    {account ? <span className="muted">{atHandle(account.handle, account.network)}</span> : null}
                    <Pill tone={VARIANT_TONE[v.status]}>{VARIANT_STATUS_LABEL[v.status]}</Pill>
                    {v.publishedAt ? <RelativeTime iso={v.publishedAt} /> : null}
                    {v.externalUrl ? (
                      <a className="variant-link" href={v.externalUrl} target="_blank" rel="noopener noreferrer">
                        Open on {networkLabel(v.network)} ↗
                      </a>
                    ) : null}
                  </div>
                  <p className="variant-text">{v.text}</p>
                  {v.thread.map((seg, i) => (
                    <p key={i} className="variant-text variant-thread">
                      {seg}
                    </p>
                  ))}
                  {v.media.length ? <div className="muted small">{plural(v.media.length, "attachment")}</div> : null}
                  {v.status === "failed" ? (
                    <div className="variant-error" role="alert">
                      <b>Failed{v.attemptCount > 1 ? ` after ${v.attemptCount} tries` : ""}.</b> {v.error ?? "The network gave no reason."}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          {post.evidence.length ? (
            <section className="dsec">
              <h3 className="section-h">Evidence</h3>
              <ul className="evidence">
                {post.evidence.map((ev, i) => (
                  <li key={i}>
                    <span className="ev-kind">{evidenceKindLabel(ev.kind)}</span>
                    {isUrl(ev.ref) ? (
                      <a className="ev-ref" href={ev.ref} target="_blank" rel="noopener noreferrer">
                        {truncate(ev.ref.replace(/^https?:\/\/(www\.)?/, ""), 40)} ↗
                      </a>
                    ) : (
                      <span className="ev-ref">{ev.ref}</span>
                    )}
                    {ev.note ? <span className="ev-note">{ev.note}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {post.policyDecision && post.policyDecision.violations.length ? (
            <section className={`dsec ${post.policyDecision.verdict === "block" ? "card-blocked" : "card-flag"}`}>
              <h3 className="section-h">{post.policyDecision.verdict === "block" ? "Blocked by a red line" : "Flagged by a red line"}</h3>
              <ul className="violations">
                {post.policyDecision.violations.map((v, i) => (
                  <li key={i}>
                    {v.message}
                    {v.matches.length ? <span className="mono match">{v.matches.join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="dsec">
            <h3 className="section-h">History</h3>
            {history.length ? (
              <ol className="timeline">
                {history.map((ev) => (
                  <li key={ev.id} className={`tl-item tl-${ev.type.replace(/\./g, "-")}`}>
                    <time className="mono tl-time" dateTime={ev.occurredAt}>
                      {formatDateTime(ev.occurredAt)}
                    </time>
                    <span className="tl-text">{describeEvent(ev)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Nothing recorded yet.</p>
            )}
          </section>

          <details className="dsec details">
            <summary>Details</summary>
            <dl className="kv">
              <dt>Post</dt>
              <dd className="mono">{post.id}</dd>
              {data.variants.map((v) => (
                <div key={v.id} className="kv-row">
                  <dt>{networkLabel(v.network)} variant</dt>
                  <dd className="mono">
                    {v.id}
                    {v.externalId ? ` · ${v.externalId}` : ""}
                  </dd>
                </div>
              ))}
              {post.trendTopicId ? (
                <>
                  <dt>Topic</dt>
                  <dd className="mono">{post.trendTopicId}</dd>
                </>
              ) : null}
              {post.trendForecastId ? (
                <>
                  <dt>Forecast</dt>
                  <dd className="mono">{post.trendForecastId}</dd>
                </>
              ) : null}
              {post.experimentId ? (
                <>
                  <dt>Experiment</dt>
                  <dd className="mono">
                    {post.experimentId}
                    {post.experimentArm ? ` · ${post.experimentArm}` : ""}
                  </dd>
                </>
              ) : null}
              {post.policyDecision ? (
                <>
                  <dt>Policy version</dt>
                  <dd className="mono">{post.policyDecision.policyVersion}</dd>
                </>
              ) : null}
              {data.approvals.map((a) => (
                <div key={a.id} className="kv-row">
                  <dt>Approval</dt>
                  <dd className="mono">
                    {a.id} · {a.state}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      ) : null}
    </Drawer>
  );
}

/** Ledger event → one plain sentence. */
function describeEvent(ev: LedgerEvent): string {
  const d = ev.data ?? {};
  const who = actorPhrase(ev.actor);
  const net = typeof d.network === "string" ? networkLabel(d.network) : null;
  switch (ev.type) {
    case "post.created":
      return `Created by ${who}`;
    case "policy.evaluated":
      return d.verdict === "block"
        ? "Checked against red lines · blocked"
        : d.verdict === "require_approval"
          ? "Checked against red lines · approval required"
          : "Checked against red lines · clear";
    case "policy.blocked":
      return "Blocked by a red line";
    case "post.approval_requested":
      return "Approval requested";
    case "post.approval_decided": {
      const outcome = typeof d.outcome === "string" ? d.outcome : typeof d.decision === "string" ? d.decision : "";
      const note = typeof d.note === "string" && d.note ? ` ("${d.note}")` : "";
      if (outcome === "approved" || outcome === "approve") return `Approved by ${who}${note}`;
      if (outcome === "rejected" || outcome === "reject") return `Rejected by ${who}${note}`;
      return `Changes requested by ${who}${note}`;
    }
    case "post.scheduled":
      return typeof d.at === "string" ? `Scheduled for ${formatDateTime(d.at)}` : "Scheduled";
    case "post.publish_started":
      return "Started going out";
    case "variant.published":
      return net ? `Went out on ${net}` : "Went out";
    case "variant.failed":
      return `${net ? `Failed on ${net}` : "Failed"}${typeof d.error === "string" ? `: ${d.error}` : ""}`;
    case "post.published":
      return "Went out everywhere";
    case "post.failed":
      return "Didn't go out everywhere";
    case "post.cancelled":
      return `Cancelled by ${who}`;
    case "post.updated":
      return `Edited by ${who}`;
    case "outcome.scheduled":
      return "Outcome check scheduled";
    case "outcome.captured": {
      const parts: string[] = [];
      const m = (d.metrics && typeof d.metrics === "object" ? d.metrics : d) as Record<string, unknown>;
      if (typeof m.impressions === "number") parts.push(`${compact(m.impressions)} impressions`);
      if (typeof m.engagements === "number") parts.push(`${compact(m.engagements)} engagements`);
      if (typeof m.lift === "number") parts.push(`${lift(m.lift)} lift`);
      const head = typeof d.offset === "string" ? `${d.offset} outcome` : "Outcome";
      return parts.length ? `${head}: ${parts.join(" · ")}` : `${head} captured`;
    }
    case "trend.action_recorded":
      return "Recorded as an action on its topic";
    default:
      return ev.type.replace(/[._]/g, " ");
  }
}
