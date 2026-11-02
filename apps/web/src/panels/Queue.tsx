import type { ReactNode } from "react";
import type { PostSummary } from "../types";
import { PanelState } from "../components/PanelState";
import { PostCard } from "./PostCard";

export function Queue({
  items,
  loading,
  error,
  onRetry,
  onDecided,
  head,
}: {
  items: PostSummary[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onDecided: (id: string, decision: "approve" | "reject") => void;
  /** Replaces the plain title, e.g. with the Queue · Calendar switch. */
  head?: ReactNode;
}) {
  return (
    <section className="panel panel-queue" aria-label="Queue">
      <header className="panel-head">
        {head ?? <h2>Queue</h2>}
        <span className="panel-meta mono">{items ? `${items.length} waiting on you` : ""}</span>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={onRetry} empty={items && items.length === 0 ? "Nothing is waiting on you." : null} />
        {items?.map((item) => <PostCard key={item.post.id} item={item} onDecided={onDecided} />)}
      </div>
    </section>
  );
}
