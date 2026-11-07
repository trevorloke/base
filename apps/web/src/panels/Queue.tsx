import type { ReactNode } from "react";
import type { PostSummary } from "../types";
import { PanelState } from "../components/PanelState";
import { useRoom } from "../lib/room";
import { networkLabel, plural, truncate } from "../lib/format";
import { PostCard } from "./PostCard";

export function Queue({
  items,
  loading,
  error,
  onRetry,
  onDecided,
  drafts = [],
  head,
}: {
  items: PostSummary[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDecided: (id: string, decision: "approve" | "reject") => void;
  /** Saved drafts, listed under what waits on a decision. */
  drafts?: PostSummary[];
  /** Replaces the plain title, e.g. with the Queue · Calendar switch. */
  head?: ReactNode;
}) {
  const { accountsById, openAccounts, openCompose, openPost } = useRoom();
  const empty =
    accountsById.size === 0 ? (
      <>
        Nothing is waiting on you.{" "}
        <button type="button" className="linkish strong" onClick={openAccounts}>
          Connect an account
        </button>{" "}
        to start posting; posts that need your approval land here.
      </>
    ) : (
      <>
        Nothing is waiting on you. Posts that need your approval land here.{" "}
        <button type="button" className="linkish strong" onClick={() => openCompose()}>
          Write a post
        </button>
      </>
    );
  return (
    <section className="panel panel-queue" aria-label="Queue">
      <header className="panel-head">
        {head ?? <h2>Queue</h2>}
        <span className="panel-meta mono">{items ? `${items.length} waiting on you` : ""}</span>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={onRetry} empty={items && items.length === 0 ? empty : null} />
        {items?.map((item) => <PostCard key={item.post.id} item={item} onDecided={onDecided} />)}
        {drafts.length ? (
          <section className="queue-drafts" aria-label="Drafts">
            <h3 className="section-h">{plural(drafts.length, "draft")}</h3>
            <ul className="queue-drafts-list">
              {drafts.map((d) => (
                <li key={d.post.id}>
                  <button type="button" className="linkish" onClick={() => openPost(d.post.id)}>
                    {truncate(d.post.title ?? d.post.body, 90) || "Untitled draft"}
                  </button>
                  <span className="muted small"> · {d.variants.map((v) => networkLabel(v.network)).join(", ")}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}
